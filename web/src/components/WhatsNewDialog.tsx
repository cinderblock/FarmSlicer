import { useEffect, useState } from "react";
import { BUILD_COMMIT, BUILD_TIME, BUILD_VERSION } from "../build";
import { CHANGELOG, type ChangelogEntry } from "../changelog";

function entryDate(day: string): string {
  // Noon, so no time zone moves it to another day.
  const d = new Date(`${day}T12:00:00`);
  return Number.isNaN(d.getTime())
    ? day
    : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function Entry({ entry }: { entry: ChangelogEntry }) {
  return (
    <section className="whats-new-entry">
      <h4>
        {entry.title} <span className="hint">· {entryDate(entry.date)}</span>
      </h4>
      {entry.highlights.length > 0 && (
        <ul>
          {entry.highlights.map((h) => (
            <li key={h}>{h}</li>
          ))}
        </ul>
      )}
      {entry.fixes && (
        <p className="whats-new-fixes">
          <strong>Bug fixes:</strong> {entry.fixes}
        </p>
      )}
    </section>
  );
}

/** This build, for the footer: local time first, UTC on hover. */
function BuildLine() {
  const built = BUILD_TIME ? new Date(BUILD_TIME) : null;
  // (dateStyle/timeStyle can't be combined with timeZoneName.)
  const local = built?.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  return (
    <p className="hint whats-new-build">
      Version <span className="mono" title={BUILD_COMMIT || undefined}>{BUILD_VERSION}</span>
      {built && local && (
        <>
          {" "}
          · built <span title={built.toISOString().replace(/\.\d+Z$/, "Z")}>{local}</span>
        </>
      )}
    </p>
  );
}

/**
 * What's new: `entries` (the ones this browser hasn't seen), or the whole
 * changelog when `entries` is null or the person asks for earlier ones.
 * Closing it counts as having seen them (the caller marks them).
 */
export default function WhatsNewDialog({ entries, onClose }: { entries: ChangelogEntry[] | null; onClose: () => void }) {
  const [all, setAll] = useState(entries === null);
  const shown = all || !entries ? CHANGELOG : entries;
  const earlier = !all && entries !== null && entries.length < CHANGELOG.length;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    // Open on a screen nobody is at, it mustn't keep the next update from loading.
    <div className="modal-backdrop" data-update-safe onClick={onClose}>
      <div className="modal whats-new-dialog" role="dialog" aria-label="What's new" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>What's new</h3>
          <button className="btn-sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="whats-new-entries">
          {shown.map((entry) => (
            <Entry key={entry.id} entry={entry} />
          ))}
        </div>
        <BuildLine />
        <div className="modal-actions">
          {earlier && (
            <button className="link-button" onClick={() => setAll(true)}>
              Earlier changes
            </button>
          )}
          <button className="btn-primary" onClick={onClose}>
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
