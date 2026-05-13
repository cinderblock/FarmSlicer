import { useState, useCallback } from "react";
import ModelViewer from "../components/ModelViewer";

export default function SlicePage() {
  const [modelFile, setModelFile] = useState<File | null>(null);
  const [slicing, setSlicing] = useState(false);

  const handleSlice = useCallback(async () => {
    if (!modelFile) return;
    setSlicing(true);

    const formData = new FormData();
    formData.append("model", modelFile);
    // TODO: append config/profile selection

    try {
      const res = await fetch("/api/slice", { method: "POST", body: formData });
      const data = await res.json();
      console.log("Slice job created:", data);
    } catch (err) {
      console.error("Slice failed:", err);
    } finally {
      setSlicing(false);
    }
  }, [modelFile]);

  return (
    <div className="page slice-page">
      <h2>Slice</h2>
      <div className="slice-layout">
        <div className="viewer-panel">
          <ModelViewer onModelLoaded={setModelFile} />
        </div>
        <div className="settings-panel">
          <h3>Settings</h3>

          <label>
            Printer
            <select>
              <option>Select printer...</option>
            </select>
          </label>

          <label>
            Filament
            <select>
              <option>Select filament...</option>
            </select>
          </label>

          <label>
            Profile
            <select>
              <option>Select profile...</option>
            </select>
          </label>

          <label>
            Routing
            <select>
              <option value="auto">Auto-assign printer</option>
              <option value="lock">Lock to selected printer</option>
            </select>
          </label>

          {modelFile && (
            <div className="model-info">
              <p>{modelFile.name}</p>
              <p className="hint">
                {(modelFile.size / 1024 / 1024).toFixed(1)} MB
              </p>
            </div>
          )}

          <button
            className="btn-primary"
            disabled={!modelFile || slicing}
            onClick={handleSlice}
          >
            {slicing ? "Slicing..." : "Slice"}
          </button>
        </div>
      </div>
    </div>
  );
}
