import { reloadNow, useUpdateState } from "../appUpdate";

/** A new build is waiting: say why it hasn't loaded yet, offer to load it. */
export default function UpdateBanner() {
  const { pending, holds, dirty, reloading } = useUpdateState();
  if (!pending) return null;

  const why = reloading
    ? "Saving your work and loading it…"
    : holds.length > 0
      ? `It loads when ${holds.join(" and ")} is done.`
      : dirty
        ? "This page has changes you haven't saved: save them first, reloading discards them."
        : "It loads by itself when you go to another page or step away; your plate on the Slice page is kept.";

  return (
    <div className="update-banner" role="status">
      <span>
        <strong>FarmSlicer has been updated.</strong> {why}
      </span>
      {!reloading && (
        <button className="btn-sm" onClick={() => void reloadNow()}>
          Reload now
        </button>
      )}
    </div>
  );
}
