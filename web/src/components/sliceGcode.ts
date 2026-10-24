// Where the preview reads a slice's plate from: memory (parsed already, or
// the bytes a browser slice just made), this browser's slice cache
// (sliceCache.ts), or the server, keeping what it downloads for next time.

import { useEffect, useMemo, useState } from "react";
import { getGcode, putGcode } from "../sliceCache";
import { parsedFromMemory, type GcodeSource } from "./preview/load";

export interface SliceGcode {
  source: GcodeSource;
  /** Names the plate's file for the parsed-file memory: "<job>:<plate>". */
  cacheKey: string;
  /** Set when it comes from the server: keeps the bytes. */
  onBytes?: (bytes: Blob) => void;
}

/**
 * Plate `plate` of job `jobId`; null while this browser's cache is looked
 * in. `several`: the job has several plates (the URL names the plate).
 * `fresh`: plate 1's bytes, when this page just sliced them.
 */
export function useSliceGcode(jobId: string, plate: number, several: boolean, fresh?: Uint8Array | null): SliceGcode | null {
  const cacheKey = `${jobId}:${plate}`;
  const url = `/api/jobs/${jobId}/gcode${several ? `?plate=${plate}` : ""}`;
  const inMemory = (plate === 1 && !!fresh) || parsedFromMemory(cacheKey) !== null;
  const [stored, setStored] = useState<{ key: string; blob: Blob | null } | null>(null);

  useEffect(() => {
    if (inMemory) return;
    let stale = false;
    getGcode(jobId, plate).then((blob) => {
      if (!stale) setStored({ key: cacheKey, blob });
    });
    return () => {
      stale = true;
    };
  }, [jobId, plate, cacheKey, inMemory]);

  const looked = stored?.key === cacheKey ? stored : null;
  return useMemo((): SliceGcode | null => {
    if (plate === 1 && fresh) return { source: { data: fresh }, cacheKey };
    // Parsed already: any source will do, the memory answers first.
    if (inMemory) return { source: { url }, cacheKey };
    if (!looked) return null;
    if (looked.blob) return { source: { data: looked.blob }, cacheKey };
    return { source: { url }, cacheKey, onBytes: (bytes) => void putGcode(jobId, plate, bytes) };
  }, [plate, fresh, cacheKey, inMemory, url, looked, jobId]);
}
