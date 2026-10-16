// A streaming G-code parser: bytes in (any chunking), typed-array columns
// out (types.ts). It runs in a worker (worker.ts) and is pure TypeScript
// with no DOM, so `bun test` exercises it directly.
//
// What it understands:
// - moves: G0/G1, arcs G2/G3 (I/J or R, full circles, helical Z; split into
//   short chords), G90/G91, M82/M83 (E follows G91 too, as in Marlin and
//   Klipper), G92 for any axis, G20/G21, G28, firmware retraction G10/G11;
// - tools: T0..T63 (Bambu's T255/T1000/T1100 are not filaments);
// - the slicers' comments: OrcaSlicer/BambuStudio (`; CHANGE_LAYER`,
//   `; Z_HEIGHT:`, `; LAYER_HEIGHT:`, `; FEATURE:`, `; LINE_WIDTH:`),
//   OrcaSlicer/PrusaSlicer generic (`;LAYER_CHANGE`, `;Z:`, `;HEIGHT:`,
//   `;TYPE:`, `;WIDTH:`), Cura (`;LAYER:`, `;TYPE:`, `;TIME_ELAPSED:`), and
//   `; key = value` settings (colours, bed, estimates, filament use).
//   Thumbnails are skipped without decoding.
// - without layer comments, a layer starts wherever extrusion moves to a new Z.
//
// Times: a kinematic estimate per move (trapezoidal speed profile, the
// file's M204 accelerations and M203 limits, cornering slowed by the angle
// between moves), scaled so the total matches the slicer's own estimate
// when the header has one.

import { canonicalFeature } from "./features";
import {
  GAP,
  RETRACT,
  TRAVEL,
  UNRETRACT,
  WIPE,
  type Extrusions,
  type FilamentUse,
  type GcodeInfo,
  type Layers,
  type ParsedGcode,
  type Retractions,
  type Travels,
} from "./types";

// ---- numbers ------------------------------------------------------------------

const POW10 = Array.from({ length: 24 }, (_, i) => 10 ** i);

/** Where the last `readNumber` stopped. */
let numEnd = 0;

/** A decimal number at b[i..end) ("-12", ".5", "3.25"); NaN when there is none. */
function readNumber(b: Uint8Array, i: number, end: number): number {
  let neg = false;
  if (i < end && (b[i] === 45 || b[i] === 43)) {
    neg = b[i] === 45;
    i++;
  }
  let v = 0;
  let digits = 0;
  while (i < end) {
    const d = b[i] - 48;
    if (d < 0 || d > 9) break;
    v = v * 10 + d;
    i++;
    digits++;
  }
  if (i < end && b[i] === 46) {
    i++;
    let frac = 0;
    let n = 0;
    while (i < end) {
      const d = b[i] - 48;
      if (d < 0 || d > 9) break;
      if (n < 18) {
        frac = frac * 10 + d;
        n++;
      }
      i++;
      digits++;
    }
    v += frac / POW10[n];
  }
  numEnd = i;
  if (digits === 0) return NaN;
  return neg ? -v : v;
}

/** "1d 2h 3m 4s" (any subset) → seconds; NaN if none of it is there. */
export function parseDuration(text: string): number {
  let total = 0;
  let found = false;
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*([dhms])/g)) {
    const n = Number(m[1]);
    total += n * { d: 86400, h: 3600, m: 60, s: 1 }[m[2] as "d" | "h" | "m" | "s"];
    found = true;
  }
  return found ? total : NaN;
}

// ---- growable columns -------------------------------------------------------

function grow<T extends Float32Array | Uint8Array | Uint16Array | Uint32Array>(a: T, size: number): T {
  const next = new (a.constructor as new (n: number) => T)(size);
  next.set(a);
  return next;
}

const u16 = (v: number) => Math.min(65535, Math.max(0, Math.round(v)));

class ExtrusionColumns {
  /** Segments so far (gaps included). */
  n = 0;
  cap = 1 << 14;
  points = new Float32Array((this.cap + 1) * 3);
  size = new Uint16Array(this.cap * 2);
  feature = new Uint8Array(this.cap);
  tool = new Uint8Array(this.cap);
  speed = new Uint16Array(this.cap);
  /** 1 = width estimated from E (fixed up once the filament diameter is known). */
  estimated = new Uint8Array(this.cap);
  /** The chain's last point (full precision), once it has one. */
  started = false;
  lx = 0;
  ly = 0;
  lz = 0;

  more() {
    const cap = Math.ceil(this.cap * 1.5);
    this.points = grow(this.points, (cap + 1) * 3);
    this.size = grow(this.size, cap * 2);
    this.feature = grow(this.feature, cap);
    this.tool = grow(this.tool, cap);
    this.speed = grow(this.speed, cap);
    this.estimated = grow(this.estimated, cap);
    this.cap = cap;
  }

  /** Extend the chain to (x, y, z); returns the new segment's index. */
  to(x: number, y: number, z: number): number {
    if (this.n === this.cap) this.more();
    const n = this.n++;
    const o = (n + 1) * 3;
    this.points[o] = x;
    this.points[o + 1] = y;
    this.points[o + 2] = z;
    this.lx = x;
    this.ly = y;
    this.lz = z;
    return n;
  }

  /** Make the chain continue from (x, y, z), with a gap segment if it isn't there. */
  from(x: number, y: number, z: number, tool: number) {
    if (!this.started) {
      this.points[0] = x;
      this.points[1] = y;
      this.points[2] = z;
      this.lx = x;
      this.ly = y;
      this.lz = z;
      this.started = true;
    } else if (x !== this.lx || y !== this.ly || z !== this.lz) {
      const n = this.to(x, y, z);
      this.feature[n] = GAP;
      this.tool[n] = tool;
    }
  }

  done(): Extrusions {
    const n = this.n;
    return {
      count: n,
      points: this.points.slice(0, (n + 1) * 3),
      size: this.size.slice(0, n * 2),
      feature: this.feature.slice(0, n),
      tool: this.tool.slice(0, n),
      speed: this.speed.slice(0, n),
    };
  }
}

class TravelColumns {
  n = 0;
  cap = 1 << 13;
  ends = new Float32Array(this.cap * 6);
  kind = new Uint8Array(this.cap);
  speed = new Uint16Array(this.cap);
  line = new Uint32Array(this.cap);
  at = new Uint32Array(this.cap);

  more() {
    const cap = Math.ceil(this.cap * 1.5);
    this.ends = grow(this.ends, cap * 6);
    this.kind = grow(this.kind, cap);
    this.speed = grow(this.speed, cap);
    this.line = grow(this.line, cap);
    this.at = grow(this.at, cap);
    this.cap = cap;
  }

  done(): Travels {
    const n = this.n;
    return {
      count: n,
      ends: this.ends.slice(0, n * 6),
      kind: this.kind.slice(0, n),
      speed: this.speed.slice(0, n),
      line: this.line.slice(0, n),
      at: this.at.slice(0, n),
    };
  }
}

class RetractColumns {
  n = 0;
  cap = 1 << 12;
  pos = new Float32Array(this.cap * 3);
  kind = new Uint8Array(this.cap);
  line = new Uint32Array(this.cap);
  at = new Uint32Array(this.cap);

  more() {
    const cap = Math.ceil(this.cap * 1.5);
    this.pos = grow(this.pos, cap * 3);
    this.kind = grow(this.kind, cap);
    this.line = grow(this.line, cap);
    this.at = grow(this.at, cap);
    this.cap = cap;
  }

  done(): Retractions {
    const n = this.n;
    return {
      count: n,
      pos: this.pos.slice(0, n * 3),
      kind: this.kind.slice(0, n),
      line: this.line.slice(0, n),
      at: this.at.slice(0, n),
    };
  }
}

/** Where a layer starts: counts of everything before it, and the clock. */
interface Boundary {
  extrusions: number;
  travels: number;
  retractions: number;
  line: number;
  time: number;
  /** NaN until a comment (or the first extrusion) says. */
  z: number;
  height: number;
}

/** Settings worth keeping from `; key = value` lines. */
const WANTED = new Set([
  "printable_area",
  "bed_shape",
  "printable_height",
  "max_print_height",
  "filament_colour",
  "extruder_colour",
  "filament_type",
  "filament_diameter",
  "filament_density",
  "nozzle_diameter",
  "layer_height",
  "printer_model",
  "printer_settings_id",
  "filament_settings_id",
  "print_settings_id",
  "gcode_flavor",
  "default_acceleration",
  "travel_acceleration",
  "machine_max_jerk_x",
  "estimated printing time (normal mode)",
  "estimated first layer printing time (normal mode)",
  "filament used [mm]",
  "filament used [g]",
  "filament used [cm3]",
  "total filament used [g]",
  "total layers count",
  "total layer number",
  "max_z_height",
  "model printing time",
  "total estimated time",
]);

const X = 23,
  Y = 24,
  Z = 25,
  E = 4,
  F = 5,
  I = 8,
  J = 9,
  L = 11,
  P = 15,
  R = 17,
  S = 18,
  T = 19;
const bit = (letter: number) => 1 << letter;

/**
 * Arc chords stay within this distance of the true arc (mm): a tenth of a
 * line width, invisible in the preview. Tighter multiplies the segments of
 * arc-fitted files (OrcaSlicer's gyroid infill is mostly short arcs).
 */
const ARC_TOLERANCE = 0.05;
const FILAMENT_DIAMETER = 1.75;

export class GcodeParser {
  // ---- output
  private ex = new ExtrusionColumns();
  private tr = new TravelColumns();
  private re = new RetractColumns();
  private commentLayers: Boundary[] = [];
  private zLayers: Boundary[] = [];
  /** Cura's `;TIME_ELAPSED:` at the end of each commented layer. */
  private elapsed: number[] = [];
  private featureNames: string[] = ["Custom"];
  private featureIndex = new Map<string, number>([["Custom", 0]]);
  private sawType = false;
  private meta: Record<string, string> = {};
  private generator: string | null = null;
  private curaTotal = NaN;

  // ---- machine state (physical = logical + offset)
  private x = 0;
  private y = 0;
  private z = 0;
  private e = 0;
  private ox = 0;
  private oy = 0;
  private oz = 0;
  private oe = 0;
  private relAll = false;
  private relE = false;
  private units = 1;
  /** mm/min, as written. */
  private feed = 1500;
  private tool = 0;
  private maxTool = 0;
  private toolE: number[] = [0];

  // ---- comment state
  private feature = 0;
  private commentWidth = 0;
  private commentHeight = 0;
  private thumbnail = false;

  // ---- layers by Z
  private zLayerZ = NaN;
  private zLayerHeight = 0.2;

  // ---- time
  private clock = 0;
  private featureTime: number[] = [0];
  private travelTime = 0;
  private accelPrint = 1500;
  private accelTravel = 1500;
  private sawAccel = false;
  private jerk = 8;
  private maxFeed = [Infinity, Infinity, Infinity, Infinity]; // X Y Z E, mm/s
  private pending = false;
  private pD = 0;
  private pV = 0;
  private pV0 = 0;
  private pA = 0;
  private pUx = 0;
  private pUy = 0;
  private pUz = 0;
  /** Feature index, or -1 for travel. */
  private pBucket = 0;

  // ---- bookkeeping
  private lineNo = 0;
  private bytes = 0;
  private carry: Uint8Array | null = null;
  private words = new Float64Array(26);
  /** Letters present in the last `parseWords`, with or without a number ("G28 X"). */
  private present = 0;
  private decoder = new TextDecoder();
  private bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  private modelBounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  private speedMin = Infinity;
  private speedMax = 0;

  /** Bytes consumed so far. */
  get consumed(): number {
    return this.bytes;
  }

  /** Feed the next chunk of the file. */
  push(chunk: Uint8Array): void {
    this.bytes += chunk.length;
    let start = 0;
    if (this.carry) {
      const nl = chunk.indexOf(10);
      if (nl < 0) {
        const joined = new Uint8Array(this.carry.length + chunk.length);
        joined.set(this.carry);
        joined.set(chunk, this.carry.length);
        this.carry = joined;
        return;
      }
      const joined = new Uint8Array(this.carry.length + nl);
      joined.set(this.carry);
      joined.set(chunk.subarray(0, nl), this.carry.length);
      this.carry = null;
      this.line(joined, 0, joined.length);
      start = nl + 1;
    }
    for (;;) {
      const nl = chunk.indexOf(10, start);
      if (nl < 0) break;
      this.line(chunk, start, nl);
      start = nl + 1;
    }
    if (start < chunk.length) this.carry = chunk.slice(start);
  }

  // ---- lines --------------------------------------------------------------------

  private line(b: Uint8Array, s: number, e: number): void {
    this.lineNo++;
    if (e > s && b[e - 1] === 13) e--;
    while (s < e && (b[s] === 32 || b[s] === 9)) s++;
    if (s >= e) return;
    if (b[s] === 59) this.comment(b, s + 1, e);
    else if (!this.thumbnail) this.command(b, s, e);
  }

  private command(b: Uint8Array, s: number, e: number): void {
    let letter = b[s] & 0xdf;
    let i = s + 1;
    if (letter === 78) {
      // N<line number>: skip it.
      while (i < e && b[i] >= 48 && b[i] <= 57) i++;
      while (i < e && (b[i] === 32 || b[i] === 9)) i++;
      if (i >= e) return;
      s = i;
      letter = b[s] & 0xdf;
      i = s + 1;
    }
    if (i >= e || b[i] < 48 || b[i] > 57) {
      this.extended(b, s, e);
      return;
    }
    let code = 0;
    while (i < e && b[i] >= 48 && b[i] <= 57) code = code * 10 + (b[i++] - 48);
    let sub = -1;
    if (i < e && b[i] === 46) {
      sub = 0;
      i++;
      while (i < e && b[i] >= 48 && b[i] <= 57) sub = sub * 10 + (b[i++] - 48);
    }
    if (letter === 71) {
      if (sub >= 0) return; // G29.1, G380.x...: nothing that moves the preview
      switch (code) {
        case 0:
        case 1:
          this.linear(this.parseWords(b, i, e));
          return;
        case 2:
        case 3:
          this.arc(this.parseWords(b, i, e), code === 2);
          return;
        case 4:
          this.dwell(this.parseWords(b, i, e));
          return;
        case 10: {
          const m = this.parseWords(b, i, e);
          if (!(m & (bit(P) | bit(L)))) this.firmwareRetract(RETRACT);
          return;
        }
        case 11:
          this.firmwareRetract(UNRETRACT);
          return;
        case 20:
          this.units = 25.4;
          return;
        case 21:
          this.units = 1;
          return;
        case 28:
          this.parseWords(b, i, e);
          this.home(this.present);
          return;
        case 90:
          this.relAll = false;
          return;
        case 91:
          this.relAll = true;
          return;
        case 92:
          this.setPosition(this.parseWords(b, i, e));
          return;
      }
    } else if (letter === 77) {
      if (sub >= 0) return;
      switch (code) {
        case 82:
          this.relE = false;
          return;
        case 83:
          this.relE = true;
          return;
        case 203: {
          const m = this.parseWords(b, i, e);
          const w = this.words;
          if (m & bit(X)) this.maxFeed[0] = w[X];
          if (m & bit(Y)) this.maxFeed[1] = w[Y];
          if (m & bit(Z)) this.maxFeed[2] = w[Z];
          if (m & bit(E)) this.maxFeed[3] = w[E];
          return;
        }
        case 204: {
          const m = this.parseWords(b, i, e);
          const w = this.words;
          if (m & bit(S) && w[S] > 0) this.accelPrint = this.accelTravel = w[S];
          if (m & bit(P) && w[P] > 0) this.accelPrint = w[P];
          if (m & bit(T) && w[T] > 0) this.accelTravel = w[T];
          if (m) this.sawAccel = true;
          return;
        }
        case 205: {
          const m = this.parseWords(b, i, e);
          const w = this.words;
          if (m & bit(X) && w[X] > 0) this.jerk = m & bit(Y) && w[Y] > 0 ? Math.min(w[X], w[Y]) : w[X];
          return;
        }
      }
    } else if (letter === 84) {
      if (sub < 0 && code < 64) this.setTool(code);
    }
  }

  /** Klipper's named commands; only speed limits matter here. */
  private extended(b: Uint8Array, s: number, e: number): void {
    if (e - s > 400) return;
    const text = this.decoder.decode(b.subarray(s, e)).toUpperCase();
    if (!text.startsWith("SET_VELOCITY_LIMIT")) return;
    const accel = /\bACCEL=([\d.]+)/.exec(text);
    if (accel && Number(accel[1]) > 0) {
      this.accelPrint = this.accelTravel = Number(accel[1]);
      this.sawAccel = true;
    }
    const scv = /\bSQUARE_CORNER_VELOCITY=([\d.]+)/.exec(text);
    if (scv && Number(scv[1]) > 0) this.jerk = Number(scv[1]);
  }

  /** Letter words after a command into `this.words`; returns the letters seen (bit mask). */
  private parseWords(b: Uint8Array, i: number, e: number): number {
    let mask = 0;
    let present = 0;
    const w = this.words;
    while (i < e) {
      const c = b[i];
      if (c === 59 || c === 42) break; // a comment or a checksum
      const letter = (c & 0xdf) - 65;
      if (c <= 32 || letter < 0 || letter > 25) {
        i++;
        continue;
      }
      const v = readNumber(b, i + 1, e);
      i = numEnd > i + 1 ? numEnd : i + 1;
      present |= 1 << letter;
      if (v === v) {
        w[letter] = v;
        mask |= 1 << letter;
      }
    }
    this.present = present;
    return mask;
  }

  // ---- comments -----------------------------------------------------------------

  private comment(b: Uint8Array, s: number, e: number): void {
    if (this.thumbnail) {
      // Base64 lines are ~78 characters; only short ones can end the block.
      if (e - s < 48) {
        const t = this.decoder.decode(b.subarray(s, e));
        if (/thumbnail\S* end|THUMBNAIL_BLOCK_END/i.test(t)) this.thumbnail = false;
      }
      return;
    }
    while (s < e && (b[s] === 32 || b[s] === 9)) s++;
    if (s >= e || e - s > 4096) return;
    const t = this.decoder.decode(b.subarray(s, e));
    const c = t.charCodeAt(0);
    // Most comments in the body: dispatch on the first letter.
    switch (c) {
      case 84: // T
        if (t.startsWith("TYPE:")) return this.setFeature(t.slice(5));
        if (t.startsWith("TIME_ELAPSED:")) {
          this.elapsed[this.commentLayers.length - 1] = Number(t.slice(13));
          return;
        }
        if (t.startsWith("TIME:")) {
          this.curaTotal = Number(t.slice(5));
          return;
        }
        if (t.startsWith("THUMBNAIL_BLOCK_START")) return;
        break;
      case 70: // F
        if (t.startsWith("FEATURE:")) return this.setFeature(t.slice(8));
        break;
      case 76: // L
        if (t.startsWith("LAYER_CHANGE")) return this.layerComment();
        if (t.startsWith("LAYER:")) return this.layerComment();
        if (t.startsWith("LINE_WIDTH:")) return this.setWidth(t.slice(11));
        if (t.startsWith("LAYER_HEIGHT:")) return this.setHeight(t.slice(13));
        break;
      case 67: // C
        if (t.startsWith("CHANGE_LAYER")) return this.layerComment();
        break;
      case 90: // Z
        if (t.startsWith("Z_HEIGHT:")) return this.setLayerZ(t.slice(9));
        if (t.startsWith("Z:")) return this.setLayerZ(t.slice(2));
        break;
      case 72: // H
        if (t.startsWith("HEIGHT:")) return this.setHeight(t.slice(7));
        break;
      case 87: // W
        if (t.startsWith("WIDTH:")) return this.setWidth(t.slice(6));
        if (t.startsWith("WIPE_")) return;
        break;
    }
    if (/^thumbnail\S* begin/i.test(t)) {
      this.thumbnail = true;
      return;
    }
    if (this.generator === null) {
      const gen = /^(?:generated by|Generated with)\s+(.+?)(?:\s+on\s+\d{4}-\d\d-\d\d.*)?$/.exec(t);
      if (gen) {
        this.generator = gen[1].trim();
        return;
      }
    }
    // Settings: "key = value" (config blocks), "key: value" (Bambu's header),
    // and "model printing time: ...; total estimated time: ..." on one line.
    const eq = t.indexOf(" = ");
    if (eq > 0) {
      const key = t.slice(0, eq).trim();
      if (WANTED.has(key)) this.setting(key, t.slice(eq + 3).trim());
      return;
    }
    for (const part of t.split(";")) {
      const colon = part.indexOf(":");
      if (colon <= 0) continue;
      const key = part.slice(0, colon).trim();
      if (WANTED.has(key)) this.setting(key, part.slice(colon + 1).trim());
    }
  }

  private setting(key: string, value: string): void {
    this.meta[key] = value;
    if (this.sawAccel) return;
    // Starting accelerations, until the G-code sets its own.
    const n = parseFloat(value);
    if (!(n > 0)) return;
    if (key === "default_acceleration") this.accelPrint = this.accelTravel = n;
    else if (key === "travel_acceleration") this.accelTravel = n;
  }

  private setFeature(name: string): void {
    const canonical = canonicalFeature(name);
    if (!canonical) return;
    this.sawType = true;
    let index = this.featureIndex.get(canonical);
    if (index === undefined) {
      if (this.featureNames.length >= 255) return;
      index = this.featureNames.length;
      this.featureNames.push(canonical);
      this.featureIndex.set(canonical, index);
      this.featureTime.push(0);
    }
    this.feature = index;
  }

  private setWidth(text: string): void {
    const w = parseFloat(text);
    if (w > 0 && w < 10) this.commentWidth = w;
  }

  private setHeight(text: string): void {
    const h = parseFloat(text);
    if (h > 0 && h < 10) {
      this.commentHeight = h;
      const layer = this.commentLayers[this.commentLayers.length - 1];
      if (layer && Number.isNaN(layer.height)) layer.height = h;
    }
  }

  private setLayerZ(text: string): void {
    const z = parseFloat(text);
    const layer = this.commentLayers[this.commentLayers.length - 1];
    if (layer && Number.isNaN(layer.z) && Number.isFinite(z)) layer.z = z;
  }

  private boundary(): Boundary {
    return {
      extrusions: this.ex.n,
      travels: this.tr.n,
      retractions: this.re.n,
      line: this.lineNo,
      time: this.clock,
      z: NaN,
      height: NaN,
    };
  }

  private layerComment(): void {
    // The move before the layer change ends in this layer.
    this.flush(Math.min(this.jerk, this.pV));
    this.commentLayers.push(this.boundary());
  }

  // ---- moves ----------------------------------------------------------------------

  private target(mask: number): [number, number, number, number] {
    const w = this.words;
    const u = this.units;
    const rel = this.relAll;
    const tx = mask & bit(X) ? (rel ? this.x + w[X] * u : w[X] * u + this.ox) : this.x;
    const ty = mask & bit(Y) ? (rel ? this.y + w[Y] * u : w[Y] * u + this.oy) : this.y;
    const tz = mask & bit(Z) ? (rel ? this.z + w[Z] * u : w[Z] * u + this.oz) : this.z;
    let de = 0;
    if (mask & bit(E)) de = rel || this.relE ? w[E] * u : w[E] * u + this.oe - this.e;
    return [tx, ty, tz, de];
  }

  private linear(mask: number): void {
    if (mask & bit(F) && this.words[F] > 0) this.feed = this.words[F] * this.units;
    if (!(mask & (bit(X) | bit(Y) | bit(Z) | bit(E)))) return;
    const [tx, ty, tz, de] = this.target(mask);
    this.moveTo(tx, ty, tz, de);
  }

  private arc(mask: number, clockwise: boolean): void {
    const w = this.words;
    const u = this.units;
    if (mask & bit(F) && w[F] > 0) this.feed = w[F] * u;
    const [tx, ty, tz, de] = this.target(mask);
    const x0 = this.x;
    const y0 = this.y;
    const z0 = this.z;
    let cx: number;
    let cy: number;
    if (mask & (bit(I) | bit(J))) {
      cx = x0 + (mask & bit(I) ? w[I] * u : 0);
      cy = y0 + (mask & bit(J) ? w[J] * u : 0);
    } else if (mask & bit(R)) {
      // Centre from the radius: on the chord's perpendicular bisector; a
      // negative R picks the long way round.
      const r = w[R] * u;
      const mx = (x0 + tx) / 2;
      const my = (y0 + ty) / 2;
      const dx = tx - x0;
      const dy = ty - y0;
      const chord = Math.hypot(dx, dy);
      if (chord < 1e-9) return;
      const h = Math.sqrt(Math.max(0, r * r - (chord / 2) ** 2));
      const side = (clockwise ? 1 : -1) * (r < 0 ? -1 : 1);
      cx = mx + (side * h * dy) / chord;
      cy = my - (side * h * dx) / chord;
    } else {
      this.moveTo(tx, ty, tz, de);
      return;
    }
    const r = Math.hypot(x0 - cx, y0 - cy);
    if (r < 1e-6) {
      this.moveTo(tx, ty, tz, de);
      return;
    }
    const a0 = Math.atan2(y0 - cy, x0 - cx);
    const a1 = Math.atan2(ty - cy, tx - cx);
    let sweep = a1 - a0;
    const full = Math.abs(tx - x0) < 1e-6 && Math.abs(ty - y0) < 1e-6;
    if (clockwise) {
      if (full) sweep = -2 * Math.PI;
      else if (sweep >= 0) sweep -= 2 * Math.PI;
    } else if (full) sweep = 2 * Math.PI;
    else if (sweep <= 0) sweep += 2 * Math.PI;
    if (mask & bit(P) && w[P] > 1) sweep += Math.sign(sweep) * 2 * Math.PI * (Math.round(w[P]) - 1);
    const step = Math.min(Math.PI / 8, Math.max(0.01, 2 * Math.acos(Math.max(-1, 1 - ARC_TOLERANCE / r))));
    const n = Math.min(720, Math.max(1, Math.ceil(Math.abs(sweep) / step)));
    for (let k = 1; k <= n; k++) {
      if (k === n) {
        this.moveTo(tx, ty, tz, de / n);
      } else {
        const a = a0 + (sweep * k) / n;
        this.moveTo(cx + r * Math.cos(a), cy + r * Math.sin(a), z0 + ((tz - z0) * k) / n, de / n);
      }
    }
  }

  private moveTo(tx: number, ty: number, tz: number, de: number): void {
    const dx = tx - this.x;
    const dy = ty - this.y;
    const dz = tz - this.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    this.toolE[this.tool] += de;
    if (dist < 1e-6) {
      if (de !== 0) this.retraction(de);
      this.e += de;
      return;
    }
    const ux = dx / dist;
    const uy = dy / dist;
    const uz = dz / dist;
    const feed = this.feed / 60;
    const extruding = de > 0;
    this.kinematics(dist, feed, ux, uy, uz, extruding ? this.accelPrint : this.accelTravel, extruding ? this.feature : -1);
    if (extruding) this.extrusion(tx, ty, tz, de, dist, feed);
    else this.travel(tx, ty, tz, de < 0 ? WIPE : TRAVEL, feed);
    this.x = tx;
    this.y = ty;
    this.z = tz;
    this.e += de;
  }

  private extrusion(tx: number, ty: number, tz: number, de: number, dist: number, feed: number): void {
    // Layers by Z, kept in case the file has no layer comments.
    if (!(Math.abs(tz - this.zLayerZ) <= 1e-4)) {
      const b = this.boundary();
      const prev = this.zLayerZ;
      b.z = tz;
      b.height = Number.isNaN(prev) ? tz : tz - prev;
      if (b.height > 0.005 && b.height < 2) this.zLayerHeight = b.height;
      this.zLayerZ = tz;
      this.zLayers.push(b);
    }
    const c = this.ex;
    c.from(this.x, this.y, this.z, this.tool);
    const n = c.to(tx, ty, tz);
    const height = this.commentHeight > 0 ? this.commentHeight : this.zLayerHeight;
    let width = this.commentWidth;
    // Custom G-code (start sequence, purges) carries no width comment; the
    // one in force belongs to the last feature.
    if (!(width > 0) || this.feature === 0) {
      const area = (de * Math.PI * FILAMENT_DIAMETER * FILAMENT_DIAMETER) / 4 / dist;
      width = Math.min(3, Math.max(0.05, area / height + height * (1 - Math.PI / 4)));
      c.estimated[n] = 1;
    }
    c.size[n * 2] = u16(width * 1000);
    c.size[n * 2 + 1] = u16(height * 1000);
    c.feature[n] = this.feature;
    c.tool[n] = this.tool;
    c.speed[n] = u16(feed * 10);
    if (feed < this.speedMin) this.speedMin = feed;
    if (feed > this.speedMax) this.speedMax = feed;
    this.grow(this.bounds, tx, ty, tz, this.x, this.y, this.z);
    if (this.feature !== 0) this.grow(this.modelBounds, tx, ty, tz, this.x, this.y, this.z);
  }

  private grow(bb: number[], x1: number, y1: number, z1: number, x0: number, y0: number, z0: number): void {
    bb[0] = Math.min(bb[0], x0, x1);
    bb[1] = Math.min(bb[1], y0, y1);
    bb[2] = Math.min(bb[2], z0, z1);
    bb[3] = Math.max(bb[3], x0, x1);
    bb[4] = Math.max(bb[4], y0, y1);
    bb[5] = Math.max(bb[5], z0, z1);
  }

  private travel(tx: number, ty: number, tz: number, kind: number, feed: number): void {
    const c = this.tr;
    if (c.n === c.cap) c.more();
    const n = c.n++;
    const o = n * 6;
    c.ends[o] = this.x;
    c.ends[o + 1] = this.y;
    c.ends[o + 2] = this.z;
    c.ends[o + 3] = tx;
    c.ends[o + 4] = ty;
    c.ends[o + 5] = tz;
    c.kind[n] = kind;
    c.speed[n] = u16(feed * 10);
    c.line[n] = this.lineNo;
    c.at[n] = this.ex.n;
  }

  /** Filament pulled back (de < 0) or pushed out without moving. */
  private retraction(de: number): void {
    this.flush(0);
    const v = Math.min(this.feed / 60, this.maxFeed[3]);
    if (v > 0) this.clock += Math.abs(de) / v;
    this.marker(de < 0 ? RETRACT : UNRETRACT);
  }

  private firmwareRetract(kind: number): void {
    this.flush(0);
    this.clock += 0.05;
    this.marker(kind);
  }

  private marker(kind: number): void {
    const c = this.re;
    if (c.n === c.cap) c.more();
    const n = c.n++;
    c.pos[n * 3] = this.x;
    c.pos[n * 3 + 1] = this.y;
    c.pos[n * 3 + 2] = this.z;
    c.kind[n] = kind;
    c.line[n] = this.lineNo;
    c.at[n] = this.ex.n;
  }

  private dwell(mask: number): void {
    this.flush(0);
    const w = this.words;
    if (mask & bit(P) && w[P] > 0) this.clock += w[P] / 1000;
    else if (mask & bit(S) && w[S] > 0) this.clock += w[S];
  }

  private home(mask: number): void {
    this.flush(0);
    const all = !(mask & (bit(X) | bit(Y) | bit(Z)));
    if (all || mask & bit(X)) this.x = this.ox = 0;
    if (all || mask & bit(Y)) this.y = this.oy = 0;
    if (all || mask & bit(Z)) this.z = this.oz = 0;
  }

  private setPosition(mask: number): void {
    const w = this.words;
    const u = this.units;
    if (!(mask & (bit(X) | bit(Y) | bit(Z) | bit(E)))) {
      this.ox = this.x;
      this.oy = this.y;
      this.oz = this.z;
      this.oe = this.e;
      return;
    }
    if (mask & bit(X)) this.ox = this.x - w[X] * u;
    if (mask & bit(Y)) this.oy = this.y - w[Y] * u;
    if (mask & bit(Z)) this.oz = this.z - w[Z] * u;
    if (mask & bit(E)) this.oe = this.e - w[E] * u;
  }

  private setTool(t: number): void {
    this.tool = t;
    if (t > this.maxTool) this.maxTool = t;
    while (this.toolE.length <= t) this.toolE.push(0);
  }

  // ---- time -------------------------------------------------------------------------

  /** Start timing a move; the previous one is finished now that its exit speed is known. */
  private kinematics(dist: number, feed: number, ux: number, uy: number, uz: number, accel: number, bucket: number): void {
    let v = feed;
    const m = this.maxFeed;
    if (ux !== 0) v = Math.min(v, m[0] / Math.abs(ux));
    if (uy !== 0) v = Math.min(v, m[1] / Math.abs(uy));
    if (uz !== 0) v = Math.min(v, m[2] / Math.abs(uz));
    if (!(v > 0)) v = 1;
    let v0 = Math.min(this.jerk, v);
    if (this.pending) {
      const cos = this.pUx * ux + this.pUy * uy + this.pUz * uz;
      const corner = Math.min(this.pV, v);
      const vj = Math.max(corner * Math.max(0, (1 + cos) / 2), Math.min(this.jerk, corner));
      this.finish(vj);
      v0 = vj;
    }
    this.pending = true;
    this.pD = dist;
    this.pV = v;
    this.pV0 = Math.min(v0, v);
    this.pA = accel > 0 ? accel : 1500;
    this.pUx = ux;
    this.pUy = uy;
    this.pUz = uz;
    this.pBucket = bucket;
  }

  private flush(exit: number): void {
    if (this.pending) this.finish(exit);
  }

  /** Time the pending move: trapezoidal (or triangular) speed profile. */
  private finish(exit: number): void {
    const d = this.pD;
    const v = this.pV;
    const a = this.pA;
    const v0 = this.pV0;
    const v1 = Math.min(exit, v);
    const accel = (v * v - v0 * v0) / (2 * a);
    const decel = (v * v - v1 * v1) / (2 * a);
    let t: number;
    if (accel + decel <= d) {
      t = (v - v0) / a + (v - v1) / a + (d - accel - decel) / v;
    } else {
      const peak = Math.sqrt(a * d + (v0 * v0 + v1 * v1) / 2);
      t = peak < Math.max(v0, v1) ? (2 * d) / Math.max(v0 + v1, 1e-9) : (peak - v0) / a + (peak - v1) / a;
    }
    this.clock += t;
    if (this.pBucket >= 0) this.featureTime[this.pBucket] += t;
    else this.travelTime += t;
    this.pending = false;
  }

  // ---- result ---------------------------------------------------------------------

  /** End of file: the columns, layers and what the header said. */
  done(): ParsedGcode {
    if (this.carry) {
      const last = this.carry;
      this.carry = null;
      this.line(last, 0, last.length);
    }
    this.flush(0);

    const ex = this.ex;
    // Widths estimated from E assumed 1.75 mm filament; the area scales with
    // the diameter squared.
    const diameter = parseFloat(this.meta["filament_diameter"] ?? "");
    if (diameter > 0 && Math.abs(diameter - FILAMENT_DIAMETER) > 1e-3) {
      const k = (diameter / FILAMENT_DIAMETER) ** 2;
      for (let i = 0; i < ex.n; i++) {
        if (!ex.estimated[i]) continue;
        const h = ex.size[i * 2 + 1];
        const bias = h * (1 - Math.PI / 4);
        ex.size[i * 2] = u16(Math.min(3000, Math.max(50, (ex.size[i * 2] - bias) * k + bias)));
      }
    }

    const layerComments = this.commentLayers.length > 0;
    const marks = layerComments ? this.commentLayers : this.zLayers;
    const extrusions = ex.done();
    const travels = this.tr.done();
    const retractions = this.re.done();
    const layers = this.layers(marks, extrusions);

    // Times.
    const estimate = this.clock;
    const slicerTotal = this.slicerTotal();
    let scale = 1;
    let timeSource: GcodeInfo["timeSource"] = "estimate";
    let totalTime = estimate;
    const prepare = marks.length ? marks[0].time : 0;
    let prepareTime = prepare;
    if (layerComments && this.elapsed.length >= layers.count - 1 && this.elapsed.length > 0) {
      // Cura: the elapsed time at the end of each layer.
      let prev = 0;
      for (let i = 0; i < layers.count; i++) {
        const at = this.elapsed[i];
        if (Number.isFinite(at)) {
          layers.time[i] = Math.max(0, at - prev);
          prev = at;
        }
      }
      prepareTime = 0;
      totalTime = Number.isFinite(this.curaTotal) ? this.curaTotal : prev;
      timeSource = "layers";
      scale = estimate > 0 ? totalTime / estimate : 1;
    } else if (slicerTotal > 0 && estimate > 0) {
      scale = slicerTotal / estimate;
      totalTime = slicerTotal;
      timeSource = "slicer";
      for (let i = 0; i < layers.count; i++) layers.time[i] *= scale;
      prepareTime = prepare * scale;
    }

    const features = this.featureNames.slice();
    if (!this.sawType) features[0] = "Extrusion";
    const bb = this.bounds;
    const mb = this.modelBounds;
    const box = (v: number[]) =>
      v[0] <= v[3] ? { min: [v[0], v[1], v[2]] as [number, number, number], max: [v[3], v[4], v[5]] as [number, number, number] } : null;

    const info: GcodeInfo = {
      features,
      toolCount: this.maxTool + 1,
      filamentColors: this.colors(),
      filamentTypes: (this.meta["filament_type"] ?? "").split(/[;,]/).map((s) => s.trim()).filter(Boolean),
      bed: this.bed(),
      totalTime,
      timeSource,
      prepareTime,
      featureTime: this.featureTime.map((t) => t * scale),
      travelTime: this.travelTime * scale,
      filament: this.filament(),
      generator: this.generator,
      bounds: box(bb),
      modelBounds: box(mb) ?? box(bb),
      speedRange: [Number.isFinite(this.speedMin) ? this.speedMin : 0, this.speedMax],
      layerComments,
      lines: this.lineNo,
      bytes: this.bytes,
      meta: this.meta,
    };
    return { info, layers, extrusions, travels, retractions };
  }

  private layers(marks: Boundary[], ex: Extrusions): Layers {
    const count = marks.length || (this.ex.n + this.tr.n + this.re.n > 0 ? 1 : 0);
    const l: Layers = {
      count,
      z: new Float32Array(count),
      height: new Float32Array(count),
      time: new Float32Array(count),
      extrusionStart: new Uint32Array(count + 1),
      travelStart: new Uint32Array(count + 1),
      retractStart: new Uint32Array(count + 1),
      line: new Uint32Array(count),
    };
    if (count === 0) return l;
    if (!marks.length) {
      l.extrusionStart[1] = ex.count;
      l.travelStart[1] = this.tr.n;
      l.retractStart[1] = this.re.n;
      l.line[0] = 1;
      l.z[0] = this.bounds[5] > -Infinity ? this.bounds[5] : 0;
      l.height[0] = l.z[0];
      l.time[0] = this.clock;
      return l;
    }
    let prevZ = 0;
    for (let i = 0; i < count; i++) {
      const m = marks[i];
      const next = marks[i + 1];
      // Everything before the first layer (the start sequence) shows with it.
      if (i > 0) {
        l.extrusionStart[i] = m.extrusions;
        l.travelStart[i] = m.travels;
        l.retractStart[i] = m.retractions;
      }
      l.line[i] = i === 0 ? 1 : m.line;
      let z = m.z;
      if (Number.isNaN(z)) {
        const first = m.extrusions;
        const end = next ? next.extrusions : ex.count;
        z = prevZ;
        for (let s = first; s < end; s++) {
          if (ex.feature[s] !== GAP) {
            z = ex.points[(s + 1) * 3 + 2];
            break;
          }
        }
      }
      let h = m.height;
      if (Number.isNaN(h) || h <= 0) h = i === 0 ? z : z - prevZ;
      l.z[i] = z;
      l.height[i] = Math.max(0, h);
      l.time[i] = (next ? next.time : this.clock) - m.time;
      prevZ = z;
    }
    l.extrusionStart[count] = ex.count;
    l.travelStart[count] = this.tr.n;
    l.retractStart[count] = this.re.n;
    return l;
  }

  /** The slicer's own estimate of the whole print (s), or NaN. */
  private slicerTotal(): number {
    const m = this.meta;
    for (const key of ["total estimated time", "estimated printing time (normal mode)"]) {
      if (m[key]) {
        const t = parseDuration(m[key]);
        if (t > 0) return t;
      }
    }
    return Number.isFinite(this.curaTotal) && this.curaTotal > 0 ? this.curaTotal : NaN;
  }

  private colors(): string[] {
    for (const key of ["filament_colour", "extruder_colour"]) {
      const list = (this.meta[key] ?? "")
        .split(/[;,]/)
        .map((s) => s.trim().replace(/^"|"$/g, ""))
        .filter((s) => /^#[0-9a-fA-F]{6}$/.test(s));
      if (list.length) return list.map((s) => s.toLowerCase());
    }
    return [];
  }

  private bed(): GcodeInfo["bed"] {
    const raw = this.meta["printable_area"] ?? this.meta["bed_shape"];
    if (!raw) return null;
    const area = raw
      .split(",")
      .map((p) => p.trim().split("x").map(Number))
      .filter((p): p is [number, number] => p.length === 2 && p.every(Number.isFinite));
    if (area.length < 3) return null;
    const height = parseFloat(this.meta["printable_height"] ?? this.meta["max_print_height"] ?? "");
    return { area, height: height > 0 ? height : 0 };
  }

  private filament(): FilamentUse[] {
    const list = (key: string) =>
      (this.meta[key] ?? "")
        .split(/[;,]/)
        .map((s) => parseFloat(s))
        .filter((n) => Number.isFinite(n));
    const mm = list("filament used [mm]");
    const g = list("filament used [g]");
    const density = list("filament_density");
    const diameter = list("filament_diameter");
    const tools = Math.max(this.maxTool + 1, mm.length);
    const out: FilamentUse[] = [];
    for (let t = 0; t < tools; t++) {
      const length = mm.length === tools ? mm[t] : Math.max(0, this.toolE[t] ?? 0);
      if (!(length > 0)) continue;
      let weight: number | null = g.length === tools ? g[t] : null;
      if (weight === null) {
        const rho = density[t] ?? density[0];
        const d = diameter[t] ?? diameter[0] ?? FILAMENT_DIAMETER;
        if (rho > 0) weight = ((length * Math.PI * d * d) / 4 / 1000) * rho;
      }
      out.push({ tool: t, mm: length, g: weight });
    }
    return out;
  }
}

/** Every transferable buffer in a result (for postMessage). */
export function transferables(p: ParsedGcode): ArrayBuffer[] {
  const arrays = [
    ...Object.values(p.layers),
    ...Object.values(p.extrusions),
    ...Object.values(p.travels),
    ...Object.values(p.retractions),
  ].filter((v): v is Float32Array | Uint32Array | Uint8Array => ArrayBuffer.isView(v));
  return arrays.map((a) => a.buffer as ArrayBuffer);
}

/** Parse a whole file at once (tests, small files). */
export function parseGcode(text: string | Uint8Array): ParsedGcode {
  const parser = new GcodeParser();
  parser.push(typeof text === "string" ? new TextEncoder().encode(text) : text);
  return parser.done();
}
