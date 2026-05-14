import { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import ModelViewer from "../components/ModelViewer";

interface Printer {
  id: string;
  name: string;
  machine_profile: string;
  nozzle_diameter: string;
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
  const [processes, setProcesses] = useState<ProfileEntry[]>([]);
  const [filaments, setFilaments] = useState<ProfileEntry[]>([]);
  const [printerId, setPrinterId] = useState("");
  const [selectedMachine, setSelectedMachine] = useState("");
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
  }, []);

  // Unique machine profiles derived from configured printers
  const availableMachines = useMemo(() => {
    const machines = new Set<string>();
    for (const p of printers) {
      const resolved = p.nozzle_diameter
        ? `${p.machine_profile} ${p.nozzle_diameter} nozzle`
        : p.machine_profile;
      if (resolved) machines.add(resolved);
    }
    return [...machines].sort();
  }, [printers]);

  // Resolve machine profile from the selected printer or manual selection
  const resolvedMachine = useMemo(() => {
    if (printerId) {
      const p = printers.find((pr) => pr.id === printerId);
      if (p) {
        return p.nozzle_diameter
          ? `${p.machine_profile} ${p.nozzle_diameter} nozzle`
          : p.machine_profile;
      }
    }
    return selectedMachine || availableMachines[0] || "";
  }, [printerId, printers, selectedMachine, availableMachines]);

  const handlePrinterChange = (id: string) => {
    setPrinterId(id);
    setProcess("");
    setFilament("");
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
              onChange={(e) => handlePrinterChange(e.target.value)}
            >
              <option value="">Any available</option>
              {printers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>

          {!printerId && availableMachines.length > 1 && (
            <label>
              Machine Profile
              <select
                value={selectedMachine || availableMachines[0] || ""}
                onChange={(e) => setSelectedMachine(e.target.value)}
              >
                {availableMachines.map((m) => (
                  <option key={m} value={m}>
                    {m}
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
                  {resolvedMachine
                    ? "Loading..."
                    : printers.length === 0
                      ? "Add a printer first"
                      : "Select printer first"}
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
                  {resolvedMachine
                    ? "Loading..."
                    : printers.length === 0
                      ? "Add a printer first"
                      : "Select printer first"}
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
