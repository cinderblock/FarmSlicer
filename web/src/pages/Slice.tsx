import { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import ModelViewer from "../components/ModelViewer";
import SearchSelect from "../components/SearchSelect";

interface Printer {
  id: string;
  name: string;
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
  const [machines, setMachines] = useState<ProfileEntry[]>([]);
  const [processes, setProcesses] = useState<ProfileEntry[]>([]);
  const [filaments, setFilaments] = useState<ProfileEntry[]>([]);
  const [printerId, setPrinterId] = useState("");
  const [machine, setMachine] = useState("");
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
    fetch("/api/profiles/machines")
      .then((r) => r.json())
      .then(setMachines)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!machine) {
      setProcesses([]);
      setFilaments([]);
      return;
    }
    fetch(`/api/profiles/processes?machine=${encodeURIComponent(machine)}`)
      .then((r) => r.json())
      .then((data: ProfileEntry[]) => {
        setProcesses(data);
        if (data.length > 0 && !data.some((p) => p.name === process)) {
          const standard = data.find((p) => p.name.includes("0.20mm"));
          setProcess(standard?.name ?? data[0].name);
        }
      })
      .catch(() => {});
    fetch(`/api/profiles/filaments?machine=${encodeURIComponent(machine)}`)
      .then((r) => r.json())
      .then((data: ProfileEntry[]) => {
        setFilaments(data);
        if (data.length > 0 && !data.some((f) => f.name === filament)) {
          const pla = data.find((f) => f.name.includes("PLA"));
          setFilament(pla?.name ?? data[0].name);
        }
      })
      .catch(() => {});
  }, [machine]);

  const handleSlice = useCallback(async () => {
    if (!modelFile) return;
    setSlicing(true);
    setResult(null);

    const formData = new FormData();
    formData.append("model", modelFile);
    formData.append("routing", routing);
    if (printerId) formData.append("printer_id", printerId);
    if (machine) formData.append("machine", machine);
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
  }, [modelFile, printerId, routing, machine, process, filament, navigate]);

  const machineOptions = useMemo(
    () =>
      machines.map((m) => ({
        value: m.name,
        label: m.name,
        group: m.vendor,
      })),
    [machines],
  );

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
            Machine Profile
            <SearchSelect
              options={machineOptions}
              value={machine}
              onChange={setMachine}
              placeholder="Search machines..."
            />
          </label>

          <label>
            Print Quality
            <select
              value={process}
              onChange={(e) => setProcess(e.target.value)}
              disabled={!machine}
            >
              {processes.length === 0 ? (
                <option>
                  {machine ? "Loading..." : "Select machine first"}
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
              disabled={!machine}
            >
              {filaments.length === 0 ? (
                <option>
                  {machine ? "Loading..." : "Select machine first"}
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
