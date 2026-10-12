// Loading JSON from the API in components. `useJson(url, rev)` refetches
// when the URL or `rev` changes, so a mutation followed by `setRev(r => r + 1)`
// reloads without calling setState inside an effect body.
import { useEffect, useState } from "react";

export interface Loaded<T> {
  /** undefined while the first request is in flight. */
  data: T | undefined;
  /** The server's {error} message (or HTTP status) when the request failed. */
  error: string;
  /** HTTP status of the last response (0 = network failure). */
  status: number;
}

export function useJson<T>(url: string | null, rev = 0): Loaded<T> {
  const [state, setState] = useState<Loaded<T> & { key: string }>({
    data: undefined,
    error: "",
    status: 0,
    key: "",
  });
  const key = `${url}#${rev}`;
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    fetch(url, { cache: "no-store" })
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        if (res.ok) setState({ data: body as T, error: "", status: res.status, key });
        else
          setState((prev) => ({
            data: prev.key.startsWith(`${url}#`) ? prev.data : undefined,
            error: (body && typeof body === "object" && "error" in body && String(body.error)) || `HTTP ${res.status}`,
            status: res.status,
            key,
          }));
      })
      .catch((err) => {
        if (!cancelled) setState((prev) => ({ ...prev, error: String(err), status: 0, key }));
      });
    return () => {
      cancelled = true;
    };
  }, [url, key]);
  // Data from a different URL is stale: don't show it.
  const fresh = url !== null && state.key.startsWith(`${url}#`);
  return {
    data: fresh ? state.data : undefined,
    error: fresh ? state.error : "",
    status: fresh ? state.status : 0,
  };
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** SQLite "YYYY-MM-DD HH:MM:SS" (UTC) → local date string. */
export function localDate(sqlite: string | null | undefined): string {
  if (!sqlite) return "—";
  const d = new Date(sqlite.replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? sqlite : d.toLocaleDateString();
}

export function localDateTime(sqlite: string | null | undefined): string {
  if (!sqlite) return "—";
  const d = new Date(sqlite.replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? sqlite : d.toLocaleString();
}

export function formatDuration(sec: number | null | undefined): string {
  if (sec == null) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
