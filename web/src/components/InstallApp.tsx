import { useState } from "react";
import { install, useInstallState } from "../installApp";

/** The sidebar's "Install app": the browser's dialog, or on iOS how to do it. */
export default function InstallApp() {
  const { canPrompt, iosHint } = useInstallState();
  const [showHint, setShowHint] = useState(false);
  if (!canPrompt && !iosHint) return null;

  return (
    <div className="sidebar-install">
      <button
        className="link-button"
        onClick={() => (canPrompt ? void install() : setShowHint((s) => !s))}
        aria-expanded={canPrompt ? undefined : showHint}
        title="Open FarmSlicer in its own window, from your home screen or app list"
      >
        Install app
      </button>
      {!canPrompt && showHint && (
        <p className="hint">
          Tap Share <span aria-hidden="true">(the square with an arrow)</span>, then “Add to Home Screen”.
        </p>
      )}
    </div>
  );
}
