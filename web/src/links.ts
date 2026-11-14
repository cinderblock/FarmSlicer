// Paths to the sliced views, so every page links the same way.

/**
 * A job's G-code preview: `/jobs/:id`, at a plate and a layer when given
 * (both 1-based, as the UI shows them).
 */
export function previewPath(jobId: string, plate?: number | null, layer?: number | null): string {
  const q = new URLSearchParams();
  if (plate != null && plate > 0) q.set("plate", String(plate));
  if (layer != null && layer > 0) q.set("layer", String(layer));
  const s = q.toString();
  return `/jobs/${encodeURIComponent(jobId)}${s ? `?${s}` : ""}`;
}

/** A print's page: its plate's preview, following the printer while it prints. */
export function printPath(printId: string): string {
  return `/prints/${encodeURIComponent(printId)}`;
}

/** A positive whole number from a query parameter, else null. */
export function positiveParam(raw: string | null): number | null {
  const n = Number(raw);
  return raw && Number.isInteger(n) && n > 0 ? n : null;
}
