import { useState, useEffect, useCallback } from "react";
import ModelViewer from "../components/ModelViewer";

interface Printer {
  id: string;
  name: string;
}

export default function SlicePage() {
  const [modelFile, setModelFile] = useState<File | null>(null);
  const [slicing, setSlicing] = useState(false);
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [printerId, setPrinterId] = useState("");
  const [routing, setRouting] = useState("auto");
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/printers")
      .then((r) => r.json())
      .then(setPrinters)
      .catch(() => {});
  }, []);

  const handleSlice = useCallback(async () => {
    if (!modelFile) return;
    setSlicing(true);
    setResult(null);

    const formData = new FormData();
    formData.append("model", modelFile);
    formData.append("routing", routing);
    if (printerId) {
      formData.append("printer_id", printerId);
    }

    try {
      const res = await fetch("/api/jobs", { method: "POST", body: formData });
      const data = await res.json();
      if (res.ok) {
        setResult(`Job created: ${data.id}`);
      } else {
        setResult(`Error: ${data.error}`);
      }
    } catch (err) {
      setResult(`Failed: ${err}`);
    } finally {
      setSlicing(false);
    }
  }, [modelFile, printerId, routing]);

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
            <select
              value={printerId}
              onChange={(e) => setPrinterId(e.target.value)}
            >
              <option value="">Any available</option>
              {printers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>

          <label>
            Filament
            <select>
              <option>PLA (default)</option>
              <option>PETG</option>
              <option>ABS</option>
              <option>TPU</option>
            </select>
          </label>

          <label>
            Profile
            <select>
              <option>0.20mm Standard</option>
              <option>0.12mm Fine</option>
              <option>0.28mm Draft</option>
            </select>
          </label>

          <label>
            Routing
            <select
              value={routing}
              onChange={(e) => setRouting(e.target.value)}
            >
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
            {slicing ? "Submitting..." : "Slice"}
          </button>

          {result && (
            <p className="hint" style={{ marginTop: "0.5rem" }}>
              {result}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
