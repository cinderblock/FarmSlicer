// What the slicer warned about on a job (`jobs.warnings`, a JSON list), sorted
// for people: the ones about parts printing in the air first, the technical
// ones (settings libslic3r doesn't know, from older jobs) out of the way.

/** libslic3r's warning that part of the model would print in the air. */
const SUPPORT_WARNING = /floating|cantilever|enable support|support generation/i;
/** Settings libslic3r doesn't know: harmless, for the curious. */
const TECHNICAL_WARNING = /^ignored \d+ config keys/i;

export function parseWarnings(raw: string | null | undefined): string[] {
  try {
    const v = JSON.parse(raw ?? "null");
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export interface SortedWarnings {
  /** Parts that would print in the air. */
  support: string[];
  /** Everything else worth reading. */
  other: string[];
  /** Harmless notes. */
  technical: string[];
}

export function sortWarnings(warnings: string[]): SortedWarnings {
  // Technical notes first: their key lists contain "floating" and "support".
  const technical = warnings.filter((w) => TECHNICAL_WARNING.test(w));
  const rest = warnings.filter((w) => !technical.includes(w));
  const support = rest.filter((w) => SUPPORT_WARNING.test(w));
  const other = rest.filter((w) => !support.includes(w));
  return { support, other, technical };
}
