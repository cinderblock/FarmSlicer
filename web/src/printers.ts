// Printers and their live status (src/printers_api.rs, src/bambu/status.rs).
import { useEffect, useState } from "react";

export interface Printer {
  id: string;
  name: string;
  /** Base model, e.g. "Bambu Lab X1 Carbon". */
  machine_profile: string;
  nozzle_diameter: string;
  protocol: string;
  address: string;
  /** Admins only. */
  serial_number: string | null;
  access_code_set: boolean;
  current_job: string | null;
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
  state: string | null;
  stage: number | null;
  percent: number | null;
  remaining_minutes: number | null;
  layer: number | null;
  total_layers: number | null;
  job_name: string | null;
  gcode_file: string | null;
  print_error: number | null;
  hms: { attr: number; code: number }[];
  nozzles: Temperature[];
  bed: Temperature | null;
  chamber: number | null;
  speed_level: number | null;
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
  SLICING: "Slicing",
};

/** A short label and the status-dot class for a printer. */
export function describeState(status: PrinterStatus | undefined): { label: string; tone: string } {
  if (!status) return { label: "Not connected", tone: "offline" };
  if (!status.online) return { label: "Offline", tone: "offline" };
  if (status.print_error || status.hms.length > 0) {
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
      return { label: "Connected", tone: "idle" };
    default:
      return { label: STATE_LABELS[status.state] ?? status.state, tone: "idle" };
  }
}

const hex4 = (n: number) => (n & 0xffff).toString(16).toUpperCase().padStart(4, "0");

/** HMS code as Bambu writes it: AAAA_AAAA_CCCC_CCCC. */
export function hmsCode(h: { attr: number; code: number }): string {
  return `${hex4(h.attr >>> 16)}_${hex4(h.attr)}_${hex4(h.code >>> 16)}_${hex4(h.code)}`;
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
