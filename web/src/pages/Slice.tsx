import { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import ModelViewer from "../components/ModelViewer";

interface Printer {
  id: string;
  name: string;
}

interface MachineModel {
  name: string;
  vendor: string;
  vendor_display: string;
  nozzle_diameters: string[];
}

interface ProfileEntry {
  name: string;
  vendor: string;
  description?: string;
}

export default function SlicePage() {
  const navigate = useNavigate();
  const [modelFile, setModelFile] = useState<File | null>(null);
  const [slicing, setSlicing] = useState(false);
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [models, setModels] = useState<MachineModel[]>([]);
  const [processes, setProcesses] = useState<ProfileEntry[]>([]);
  const [filaments, setFilaments] = useState<ProfileEntry[]>([]);
  const [printerId, setPrinterId] = useState("");
  const [selectedVendor, setSelectedVendor] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [selectedNozzle, setSelectedNozzle] = useState("");
  const [process, setProcess] = useState("");
  const [filament, setFilament] = useState("");
  const [routing, setRouting] = useState("auto");
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(
    null,
  );

  useEffect(() => {
    fetch("/api/printers")
      .then((r) => r.json())
      .then(setPrinters)
      .catch(() => {});
    fetch("/api/profiles/machine-models")
      .then((r) => r.json())
      .then(setModels)
      .catch(() => {});
  }, []);

  const vendors = useMemo(() => {
    const v = [...new Set(models.map((m) => m.vendor_display))];
    v.sort();
    return v;
  }, [models]);

  const vendorModels = useMemo(
    () => models.filter((m) => m.vendor_display === selectedVendor),
    [models, selectedVendor],
  );

  const currentModel = models.find((m) => m.name === selectedModel);
  const nozzleOptions = currentModel?.nozzle_diameters ?? [];

  // Resolve the full machine profile name from model + nozzle
  const resolvedMachine = useMemo(() => {
    if (!selectedModel || !selectedNozzle) return "";
    return `${selectedModel} ${selectedNozzle} nozzle`;
  }, [selectedModel, selectedNozzle]);

  const handleVendorChange = (vendor: string) => {
    setSelectedVendor(vendor);
    setSelectedModel("");
    setSelectedNozzle("");
  };

  const handleModelChange = (modelName: string) => {
    setSelectedModel(modelName);
    const m = models.find((x) => x.name === modelName);
    if (m && m.nozzle_diameters.length > 0) {
      const defaultNozzle =
        m.nozzle_diameters.find((n) => n === "0.4") ?? m.nozzle_diameters[0];
      setSelectedNozzle(defaultNozzle);
    } else {
      setSelectedNozzle("");
    }
  };

  useEffect(() => {
    if (!resolvedMachine) {
      setProcesses([]);
      setFilaments([]);
      return;
    }
    fetch(
      `/api/profiles/processes?machine=${encodeURIComponent(resolvedMachine)}`,
    )
      .then((r) => r.json())
      .then((data: ProfileEntry[]) => {
        setProcesses(data);
        if (data.length > 0 && !data.some((p) => p.name === process)) {
          const standard = data.find((p) => p.name.includes("0.20mm"));
          setProcess(standard?.name ?? data[0].name);
        }
      })
      .catch(() => {});
    fetch(
      `/api/profiles/filaments?machine=${encodeURIComponent(resolvedMachine)}`,
    )
      .then((r) => r.json())
      .then((data: ProfileEntry[]) => {
        setFilaments(data);
        if (data.length > 0 && !data.some((f) => f.name === filament)) {
          const pla = data.find((f) => f.name.includes("PLA"));
          setFilament(pla?.name ?? data[0].name);
        }
      })
      .catch(() => {});
  }, [resolvedMachine]);

  const handleSlice = useCallback(async () => {
    if (!modelFile) return;
    setSlicing(true);
    setResult(null);

    const formData = new FormData();
    formData.append("model", modelFile);
    formData.append("routing", routing);
    if (printerId) formData.append("printer_id", printerId);
    if (resolvedMachine) formData.append("machine", resolvedMachine);
    if (process) formData.append("process", process);
    if (filament) formData.append("filament", filament);

    try {
      const res = await fetch("/api/jobs", { method: "POST", body: formData });
      const data = await res.json();
      if (res.ok) {
        setResult({ ok: true, message: "Slicing started" });
        setTimeout(() => navigate("/jobs"), 1500);
      } else {
        setResult({ ok: false, message: data.error });
      }
    } catch (err) {
      setResult({ ok: false, message: `${err}` });
    } finally {
      setSlicing(false);
    }
  }, [
    modelFile,
    printerId,
    routing,
    resolvedMachine,
    process,
    filament,
    navigate,
  ]);

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
            Manufacturer
            <input
              type="text"
              list="vendor-list"
              value={selectedVendor}
              onChange={(e) => handleVendorChange(e.target.value)}
              placeholder="Type to search..."
            />
            <datalist id="vendor-list">
              {vendors.map((v) => (
                <option key={v} value={v} />
              ))}
            </datalist>
          </label>

          {selectedVendor && (
            <label>
              Printer Model
              <select
                value={selectedModel}
                onChange={(e) => handleModelChange(e.target.value)}
              >
                <option value="">Select model...</option>
                {vendorModels.map((m) => (
                  <option key={m.name} value={m.name}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          {nozzleOptions.length > 0 && (
            <label>
              Nozzle Size
              <select
                value={selectedNozzle}
                onChange={(e) => setSelectedNozzle(e.target.value)}
              >
                {nozzleOptions.map((n) => (
                  <option key={n} value={n}>
                    {n}mm
                  </option>
                ))}
              </select>
            </label>
          )}

          <label>
            Print Quality
            <select
              value={process}
              onChange={(e) => setProcess(e.target.value)}
              disabled={!resolvedMachine}
            >
              {processes.length === 0 ? (
                <option>
                  {resolvedMachine ? "Loading..." : "Select machine first"}
                </option>
              ) : (
                processes.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                  </option>
                ))
              )}
            </select>
          </label>

          <label>
            Filament
            <select
              value={filament}
              onChange={(e) => setFilament(e.target.value)}
              disabled={!resolvedMachine}
            >
              {filaments.length === 0 ? (
                <option>
                  {resolvedMachine ? "Loading..." : "Select machine first"}
                </option>
              ) : (
                filaments.map((f) => (
                  <option key={f.name} value={f.name}>
                    {f.name}
                  </option>
                ))
              )}
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
            <p
              className="hint"
              style={{
                marginTop: "0.5rem",
                color: result.ok ? "var(--success)" : "var(--error)",
              }}
            >
              {result.message}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
