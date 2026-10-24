// Reading and parsing a G-code file for a view (GcodePreview, SliceCompare):
// a worker does it (load.ts), with progress; a file kept in memory under
// its key is ready at once.

import { useEffect, useRef, useState } from "react";
import { loadGcode, parsedFromMemory, type GcodeSource, type LoadProgress } from "./load";
import type { ParsedGcode } from "./types";

export type GcodeLoad =
  | { status: "loading"; progress: LoadProgress | null }
  | { status: "error"; message: string }
  | { status: "ready"; parsed: ParsedGcode; ms: number; id: number };

/** A number per parsed file: a new one remounts the view, resetting its state. */
const ids = new WeakMap<ParsedGcode, number>();
let nextId = 1;
function idOf(p: ParsedGcode): number {
  if (!ids.has(p)) ids.set(p, nextId++);
  return ids.get(p)!;
}

/**
 * Read and parse a G-code file (in a worker), with progress. A file kept in
 * memory under `cacheKey` is ready at once.
 */
export function useGcode(source: GcodeSource, options: { cacheKey?: string; onBytes?: (bytes: Blob) => void } = {}): GcodeLoad {
  const { cacheKey, onBytes } = options;
  const isUrl = "url" in source;
  const token: unknown = cacheKey ?? (isUrl ? source.url : source.data);
  const [state, setState] = useState<{ token: unknown; load: GcodeLoad }>({ token, load: { status: "loading", progress: null } });
  const bytesTo = useRef(onBytes);
  useEffect(() => {
    bytesTo.current = onBytes;
  }, [onBytes]);

  useEffect(() => {
    const ctrl = new AbortController();
    loadGcode(source, {
      signal: ctrl.signal,
      cacheKey,
      keep: !!bytesTo.current,
      onProgress: (progress) => setState({ token, load: { status: "loading", progress } }),
    })
      .then(({ result, ms, bytes }) => {
        setState({ token, load: { status: "ready", parsed: result, ms, id: idOf(result) } });
        if (bytes) bytesTo.current?.(bytes);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setState({ token, load: { status: "error", message: err instanceof Error ? err.message : String(err) } });
      });
    return () => ctrl.abort();
    // The token names the file: another source object for it (its bytes,
    // kept after the download) is the same file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  if (state.token === token) return state.load;
  const known = cacheKey ? parsedFromMemory(cacheKey) : null;
  return known ? { status: "ready", parsed: known, ms: 0, id: idOf(known) } : { status: "loading", progress: null };
}
