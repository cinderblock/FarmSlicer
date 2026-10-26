// Printers and their live status (src/printers_api.rs, src/printer/).
import { useEffect, useState } from "react";

/** What FarmSlicer can do with a printer (src/printer/mod.rs `Capabilities`). */
export interface Capabilities {
  pause: boolean;
  stop: boolean;
  /** "levels": Bambu's four speed levels; "percent": a speed factor. */
  speed: "levels" | "percent" | null;
  heat: boolean;
  camera: boolean;
  filament_mapping: boolean;
  print_options: (keyof PrintOptions)[];
  /** What the printer takes: a sliced Bambu project or plain G-code. */
  package: "bambu3mf" | "gcode";
  outside_pictures: boolean;
}

/** One connection setting on the printer form (src/printer/mod.rs `Field`). */
export interface ConnectionField {
  key: "address" | "serial_number" | "access_code";
  label: string;
  placeholder: string;
  required: boolean;
  /** Write-only: never sent back, only whether it's set. */
  secret: boolean;
}

/** A protocol FarmSlicer speaks (GET /api/printer-protocols). */
export interface Protocol {
  id: string;
  label: string;
  capabilities: Capabilities;
  connection: { fields: ConnectionField[]; hint: string };
}

/** Materials to pre-heat for on printers that don't report what's loaded. */
export const PREHEAT_MATERIALS = ["PLA", "PETG", "ABS", "ASA", "TPU", "PA", "PC"];

export interface Printer {
  id: string;
  name: string;
  /** Base model, e.g. "Bambu Lab X1 Carbon". */
  machine_profile: string;
  nozzle_diameter: string;
  protocol: string;
  /** null: a protocol FarmSlicer doesn't speak. */
  capabilities: Capabilities | null;
  address: string;
  /** Admins only. */
  serial_number: string | null;
  access_code_set: boolean;
  /** Its connection settings are complete: FarmSlicer is linked to it. */
  configured: boolean;
  current_job: string | null;
  area: string;
  /** Installed build plate (libslic3r `curr_bed_type` name); "" = unknown. */
  plate_type: string;
  /** Dual-nozzle printers: where supports and parts go (src/nozzles.rs); "" = the default. */
  nozzle_priority: string;
  /** How it takes the queue (src/dispatch.rs). */
  dispatch?: DispatchState;
}

export interface DispatchState {
  send_mode: "manual" | "confirm" | "yolo";
  set_by: string | null;
  set_at: string | null;
  bed_clear_at: string | null;
  /** "bed": someone has to say the bed is clear before the next plate. */
  waiting_for: "bed" | null;
  /** How the printer itself says its bed was cleared: its door opened and
   *  closed, or set to READY on its screen; null = only the button. */
  clear_signal: "door" | "ready" | null;
}

/** `printers.nozzle_priority` choices ("" = the first). */
export const NOZZLE_PRIORITIES: [string, string][] = [
  ["support-right", "Supports on the right nozzle, parts on the left"],
  ["support-left", "Supports on the left nozzle, parts on the right"],
  ["slicer", "Let the slicer choose (least purging; ignores the AMS)"],
];

/** Which nozzle each filament prints from on a dual-nozzle printer (src/nozzles.rs `Plan`). */
export interface NozzlePlan {
  priority: string;
  /** How many printers' AMS were consulted. */
  printers: number;
  /** Filament 1, 2, ... */
  filaments: { nozzle: number; basis: "printable" | "loaded" | "priority"; why: string }[];
}

export const nozzleSide = (n: number) => (n === 1 ? "Left" : "Right");

/** Build plates: libslic3r name → what people call it. */
export const BED_TYPES: [string, string][] = [
  ["Textured PEI Plate", "Textured PEI"],
  ["Cool Plate", "Smooth Cool Plate"],
  ["Engineering Plate", "Engineering Plate"],
  ["High Temp Plate", "Smooth High Temp Plate"],
  ["Textured Cool Plate", "Textured Cool Plate"],
  ["Supertack Plate", "Cool Plate SuperTack"],
];

export const plateLabel = (v: string) => BED_TYPES.find(([k]) => k === v)?.[1] ?? v;

/** Filament prices (site setting; src/cost.rs). */
export interface Prices {
  currency: string;
  per_kg: Record<string, number>;
  default_per_kg: number;
}

export function formatCost(cost: number | null | undefined, currency = "$"): string {
  return cost == null ? "—" : `${currency}${cost.toFixed(2)}`;
}

/** Limits on prints sent without approval (src/groups.rs `PrintRules`). */
export interface PrintRules {
  max_minutes?: number;
  materials?: string[];
}

export function describeRules(r: PrintRules): string {
  const parts: string[] = [];
  if (r.max_minutes) parts.push(`up to ${formatMinutes(r.max_minutes)}`);
  if (r.materials?.length) parts.push(r.materials.join(", ") + " only");
  return parts.length ? parts.join("; ") : "no limits";
}

export interface Temperature {
  current: number;
  target: number;
}

export interface Tray {
  slot: number;
  unit: number | null;
  index: number;
  material: string | null;
  color: string | null;
  name: string | null;
  remain: number | null;
  nozzle_temp_min: number | null;
  nozzle_temp_max: number | null;
  /** Dual-nozzle printers: the nozzle it feeds (1 left, 2 right). */
  nozzle: number | null;
}

export interface AmsUnit {
  id: number;
  humidity: number | null;
  nozzle: number | null;
  trays: Tray[];
}

export interface PrinterStatus {
  printer_id: string;
  online: boolean;
  connection_error: string | null;
  updated_at: string | null;
  /** Normalized: IDLE, PREPARE, RUNNING, PAUSE, FINISH, FAILED, CANCELLED, SLICING. */
  state: string | null;
  /** The state as the printer names it. */
  vendor_state: string | null;
  stage: number | null;
  percent: number | null;
  remaining_minutes: number | null;
  layer: number | null;
  total_layers: number | null;
  job_name: string | null;
  /** What the printer calls the job (matches what FarmSlicer sends); null when unnamed. */
  job_key: string | null;
  /** The file being printed, as reported. */
  job_file: string | null;
  /** The printer's own error or notice text. */
  message: string | null;
  print_error: number | null;
  /** What `print_error` means, in the printer maker's words. */
  print_error_message: string | null;
  /** HMS codes, each with its text when known. */
  hms: { attr: number; code: number; message: string | null }[];
  nozzles: Temperature[];
  bed: Temperature | null;
  chamber: number | null;
  speed_level: number | null;
  speed_percent: number | null;
  wifi_signal: string | null;
  nozzle_diameter: string | null;
  ams: AmsUnit[];
  external: Tray[];
  active_slot: number | null;
}

/** Live status of every connected printer, by printer id (server-sent events). */
export function usePrinterStatuses(): Record<string, PrinterStatus> {
  const [statuses, setStatuses] = useState<Record<string, PrinterStatus>>({});
  useEffect(() => {
    const events = new EventSource("/api/printers/events");
    events.addEventListener("status", (e) => {
      const status = JSON.parse((e as MessageEvent<string>).data) as PrinterStatus;
      setStatuses((prev) => ({ ...prev, [status.printer_id]: status }));
    });
    return () => events.close();
  }, []);
  return statuses;
}

const STATE_LABELS: Record<string, string> = {
  IDLE: "Idle",
  PREPARE: "Preparing",
  RUNNING: "Printing",
  PAUSE: "Paused",
  FINISH: "Finished",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
  SLICING: "Slicing",
};

/** The printer is working on a job. */
export const isBusy = (status: PrinterStatus | null | undefined) =>
  !!status?.online && ["PREPARE", "RUNNING", "PAUSE", "SLICING"].includes(status.state ?? "");

/** A short label and the status-dot class for a printer. */
export function describeState(status: PrinterStatus | undefined): { label: string; tone: string } {
  if (!status) return { label: "Not connected", tone: "offline" };
  if (!status.online) return { label: "Offline", tone: "offline" };
  if (status.print_error || status.hms.length > 0 || status.message) {
    return { label: STATE_LABELS[status.state ?? ""] ?? "Error", tone: "error" };
  }
  switch (status.state) {
    case "RUNNING":
    case "PREPARE":
      return { label: STATE_LABELS[status.state], tone: "printing" };
    case "PAUSE":
      return { label: "Paused", tone: "paused" };
    case "FAILED":
      return { label: "Failed", tone: "error" };
    case null:
      return { label: status.vendor_state ?? "Connected", tone: "idle" };
    default:
      return { label: STATE_LABELS[status.state] ?? status.state, tone: "idle" };
  }
}

const hex4 = (n: number) => (n & 0xffff).toString(16).toUpperCase().padStart(4, "0");

/** HMS code as Bambu writes it: AAAA_AAAA_CCCC_CCCC. */
export function hmsCode(h: { attr: number; code: number }): string {
  return `${hex4(h.attr >>> 16)}_${hex4(h.attr)}_${hex4(h.code >>> 16)}_${hex4(h.code)}`;
}

/** Bambu's help page for an HMS code (src/bambu/hms.rs `help_url`): their
 *  server sends it on to the code's wiki page, or the HMS index. */
export function hmsHelpUrl(h: { attr: number; code: number }): string {
  const hex8 = (n: number) => (n >>> 0).toString(16).toUpperCase().padStart(8, "0");
  return `https://e.bambulab.com/index.php?e=${hex8(h.attr)}${hex8(h.code)}&s=device_hms&lang=en`;
}

/** `print_error` as Bambu shows it: XXXX_XXXX. */
export function printErrorCode(e: number): string {
  return `${hex4(e >>> 16)}_${hex4(e)}`;
}

export function formatMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

// ---- sending and prints (src/prints_api.rs, src/printing.rs) ----------------------

export interface FilamentUse {
  /** 1-based project filament number; ams_mapping index + 1. */
  id: number;
  material: string;
  color: string;
  filament_id: string;
  used_g: number;
  used_m: number;
  /** Dual-nozzle printers: the nozzle the slicer gave it, 1 left, 2 right. */
  nozzle?: number | null;
}

/** One thing the G-code check found (src/gcode/check.rs). */
export interface GcodeFinding {
  /** block: can't be sent; review: an admin must approve; info: worth knowing. */
  severity: "block" | "review" | "info";
  code: string;
  message: string;
  line?: number | null;
  count: number;
}

/** What the G-code check made of a plate. */
export interface GcodeCheck {
  checker: string;
  verdict: GcodeFinding["severity"] | null;
  findings: GcodeFinding[];
  stats: {
    lines: number;
    commands: number;
    time_sec: number;
    max_nozzle_c: number;
    max_bed_c: number;
    max_chamber_c: number;
    longest_heated_idle_sec: number;
    longest_dwell_sec: number;
  };
  /** Print time and filament FarmSlicer goes by (rules, quotas, cost). */
  time_sec: number;
  grams: number;
}

export interface Plate {
  index: number;
  printer_model_id: string | null;
  /** The model it was sliced for, as the slicer names it (plain G-code). */
  printer_model: string | null;
  nozzle_diameters: string | null;
  print_time_sec: number | null;
  weight_g: number | null;
  filaments: FilamentUse[];
  has_thumbnail: boolean;
  gcode_md5: string;
  check?: GcodeCheck | null;
}

/** What the G-code check tolerates (site setting; src/gcode/check.rs `Limits`). */
export interface GcodeLimits {
  max_dwell_sec: number;
  max_heated_idle_sec: number;
  nozzle_margin_c: number;
  bed_margin_c: number;
  reach_margin_mm: number;
}

/** Pre-sliced uploads: site setting and inherited group setting. */
export type UploadPolicy = "allow" | "review" | "deny";

export const UPLOAD_POLICIES: [UploadPolicy, string][] = [
  ["allow", "Allowed (their G-code is still checked)"],
  ["review", "Allowed, but every print of one needs approval"],
  ["deny", "Not allowed: slice in FarmSlicer instead"],
];

/** The worst verdict over a job's plates (from its `package_json`). */
export function packageVerdict(packageJson: string | null): {
  checked: boolean;
  verdict: GcodeCheck["verdict"];
} {
  try {
    const plates: Plate[] = JSON.parse(packageJson ?? "null")?.plates ?? [];
    const checks = plates.map((p) => p.check).filter((c): c is GcodeCheck => !!c);
    const order = [null, "info", "review", "block"] as const;
    const verdict = checks.reduce<GcodeCheck["verdict"]>(
      (worst, c) => (order.indexOf(c.verdict) > order.indexOf(worst) ? c.verdict : worst),
      null,
    );
    return { checked: plates.length > 0 && checks.length === plates.length, verdict };
  } catch {
    return { checked: false, verdict: null };
  }
}

export interface Target {
  printer_id: string;
  name: string;
  machine_profile: string;
  nozzle_diameter: string;
  /** null: a protocol FarmSlicer doesn't speak. */
  capabilities: Capabilities | null;
  /** Why the plate can't print here; null = it fits. */
  incompatible: string | null;
  /** Why the printer can't take it now; null = free. */
  busy: string | null;
  ams_mapping: number[];
  problems: string[];
  status: PrinterStatus | null;
}

export interface PrintOptions {
  bed_leveling: boolean;
  flow_calibration: boolean;
  vibration_calibration: boolean;
  timelapse: boolean;
  layer_inspect: boolean;
}

export interface PrintRecord {
  id: string;
  job_id: string | null;
  plate: number;
  printer_id: string | null;
  printer_name: string;
  user_id: string | null;
  username: string | null;
  group_id: string | null;
  file_name: string;
  /** null when the caller can't see the job (only that the printer is busy). */
  name: string | null;
  ams_mapping: string | null;
  status:
    | "pending_approval"
    | "uploading"
    | "starting"
    | "printing"
    | "paused"
    | "finished"
    | "failed"
    | "cancelled"
    | "rejected";
  approval_reason: string | null;
  decided_by: string | null;
  /** Its G-code needed review: only an admin approves it. */
  safety_review: boolean;
  progress: number;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
  can_control: boolean;
  can_approve: boolean;
  estimated_cost?: number | null;
  /** How it came out: null = nobody has said (src/outcomes.rs). */
  outcome?: "good" | "partial" | "failed" | null;
  /** Who said: a username, or "printer" / "auto" for automatic records. */
  outcome_by?: string | null;
  outcome_at?: string | null;
  outcome_note?: string | null;
  /** What it holds, one line per kind of part; counts null until recorded. */
  lines?: OutcomeLine[];
  can_record_outcome?: boolean;
}

export interface OutcomeLine {
  line: number;
  item_id: string | null;
  model_idx: number | null;
  name: string;
  planned: number;
  good: number | null;
  failed: number | null;
  reason: string | null;
}

export interface OutcomeReason {
  id: string;
  label: string;
}

/** "5/6 good", "Failed", "Unchecked"... for a print that has ended. */
export function outcomeText(p: PrintRecord): string {
  if (!p.outcome) return p.status === "finished" ? "Unchecked" : "—";
  const lines = p.lines ?? [];
  const planned = lines.reduce((n, l) => n + l.planned, 0);
  const good = lines.reduce((n, l) => n + (l.good ?? 0), 0);
  if (p.outcome === "good") return planned > 1 ? `All ${planned} good` : "Good";
  if (p.outcome === "failed") return planned > 1 ? `All ${planned} failed` : "Failed";
  return `${good}/${planned} good`;
}

export const ACTIVE_PRINT = ["uploading", "starting", "printing", "paused"];

/** Prints still using a printer, by printer id, refreshed every few seconds. */
export function useActivePrints(rev = 0): Record<string, PrintRecord> {
  const [prints, setPrints] = useState<Record<string, PrintRecord>>({});
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetch("/api/prints?active=1", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : []))
        .then((list: PrintRecord[]) => {
          if (cancelled) return;
          const byPrinter: Record<string, PrintRecord> = {};
          for (const p of list) if (p.printer_id && !byPrinter[p.printer_id]) byPrinter[p.printer_id] = p;
          setPrints(byPrinter);
        })
        .catch(() => {});
    load();
    const t = setInterval(load, 3000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [rev]);
  return prints;
}

/** Every loaded tray of a printer (AMS units, then external spools). */
export function loadedTrays(status: PrinterStatus | null | undefined): Tray[] {
  if (!status) return [];
  return [...status.ams.flatMap((u) => u.trays), ...status.external].filter((t) => t.material);
}

/** The nozzle a tray feeds on a dual-nozzle printer (its AMS unit's): 1 left, 2 right. */
export function trayNozzle(status: PrinterStatus | null | undefined, t: Tray): number | null {
  if (t.unit == null || !status) return null;
  return status.ams.find((u) => u.id === t.unit)?.nozzle ?? null;
}

export const nozzleName = (n: number) => (n === 1 ? "left" : "right");

export function slotLabel(t: Tray): string {
  if (t.slot === 254 || t.slot === 255) return "External";
  if (t.unit != null && t.unit >= 128) return `AMS HT ${t.unit - 127}`;
  return `AMS ${(t.unit ?? 0) + 1} · ${t.index + 1}`;
}
