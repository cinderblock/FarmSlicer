// Number formatting for the preview's readouts.

/** Seconds → "45 s", "3m 12s", "2h 05m", "2d 4h". */
export function formatSeconds(sec: number): string {
  if (!Number.isFinite(sec)) return "—";
  const s = Math.round(sec);
  if (s < 60) return `${s} s`;
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m ${String(s % 60).padStart(2, "0")}s`;
}

/** Bytes → "4.9 MB", "291 MB". */
export function formatMegabytes(bytes: number): string {
  return `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} MB`;
}
