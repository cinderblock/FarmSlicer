import { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import ModelViewer from "../components/ModelViewer";
import OverridesPanel from "../components/OverridesPanel";

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

// Extract the base material type from a filament profile name.
// e.g., "Bambu PLA Aero @BBL X1C" → "PLA"
//       "Generic PETG-CF @BBL H2D" → "PETG"
//       "Bambu PA6-CF @BBL H2D" → "PA"
function materialType(name: string): string {
  const base = name.replace(/@.*$/, "").trim();
  const afterBrand = base.replace(/^\S+\s+/, "");

  // Ordered: check longer/more-specific prefixes first.
  // Composites (PA6-CF, PLA-CF, PETG-CF, ...) group with their base polymer.
  const groups: [string, string][] = [
    ["PAHT", "PA"],
    ["PA6", "PA"],
    ["PA", "PA"],
    ["PETG", "PETG"],
    ["PET", "PET"],
    ["PLA", "PLA"],
    ["PPS", "PPS"],
    ["PPA", "PPA"],
    ["PP", "PP"],
    ["PCTG", "PCTG"],
    ["PC", "PC"],
    ["PE", "PE"],
    ["ASA", "ASA"],
    ["ABS", "ABS"],
    ["TPU", "TPU"],
    ["PVA", "PVA"],
    ["BVOH", "BVOH"],
    ["HIPS", "HIPS"],
    ["EVA", "EVA"],
    ["PHA", "PHA"],
    ["Support", "Support"],
  ];

  for (const [prefix, group] of groups) {
    if (afterBrand.startsWith(prefix)) return group;
  }
  return "Other";
}

// Extract the structural material variant from a filament profile name.
// CF (Carbon Fiber), GF (Glass Fiber), FR (Fire Retardant) are compositional
// modifiers that fundamentally change printing requirements (e.g., hardened nozzle).
// Returns "Standard" for base materials without a structural modifier.
function materialVariant(name: string): string {
  const base = name.replace(/@.*$/, "").trim();
  const afterBrand = base.replace(/^\S+\s+/, "");

  // Match hyphenated structural suffixes: PLA-CF, PA6-GF, PETG-CF, etc.
  const hyphenMatch = afterBrand.match(/-(\w+)/);
  if (hyphenMatch) {
    const suffix = hyphenMatch[1].toUpperCase();
    if (["CF", "GF", "FR"].includes(suffix)) return suffix;
  }

  // Space-separated: "PC FR"
  if (/\bFR\b/.test(afterBrand) && materialType(name) === "PC") return "FR";

  return "Standard";
}

// Strip the @machine suffix for display
function filamentDisplayName(name: string): string {
  return name.replace(/@.*$/, "").trim();
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
  const [materialFilter, setMaterialFilter] = useState("");
  const [variantFilter, setVariantFilter] = useState("");
  const [color, setColor] = useState("");
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [resolvedConfig, setResolvedConfig] = useState<Record<string, string> | null>(null);
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

  // Material types available for the current filament list
  const materialTypes = useMemo(() => {
    const types = new Set(filaments.map((f) => materialType(f.name)));
    return [...types].sort();
  }, [filaments]);

  // Structural variants available for the selected material type
  const availableVariants = useMemo(() => {
    if (!materialFilter) return [];
    const ofType = filaments.filter((f) => materialType(f.name) === materialFilter);
    const variants = [...new Set(ofType.map((f) => materialVariant(f.name)))];
    return variants.sort((a, b) =>
      a === "Standard" ? -1 : b === "Standard" ? 1 : a.localeCompare(b),
    );
  }, [filaments, materialFilter]);

  // Filaments filtered by material type and structural variant
  const filteredFilaments = useMemo(() => {
    let filtered = filaments;
    if (materialFilter) {
      filtered = filtered.filter((f) => materialType(f.name) === materialFilter);
    }
    if (variantFilter) {
      filtered = filtered.filter(
        (f) => materialVariant(f.name) === variantFilter,
      );
    }
    return filtered;
  }, [filaments, materialFilter, variantFilter]);

  const handlePrinterChange = (id: string) => {
    setPrinterId(id);
    setProcess("");
    setFilament("");
    setMaterialFilter("");
    setVariantFilter("");
  };

  const handleMaterialChange = (type: string) => {
    setMaterialFilter(type);
    const ofType = type
      ? filaments.filter((f) => materialType(f.name) === type)
      : filaments;
    // Default to "Standard" variant if available
    const variants = [...new Set(ofType.map((f) => materialVariant(f.name)))];
    const defaultVariant = variants.includes("Standard")
      ? "Standard"
      : variants[0] ?? "";
    setVariantFilter(defaultVariant);
    // Auto-select filament from the variant-filtered set
    const filtered = ofType.filter(
      (f) => materialVariant(f.name) === defaultVariant,
    );
    if (filtered.length > 0 && !filtered.some((f) => f.name === filament)) {
      const basic =
        filtered.find((f) => f.name.includes("Basic")) ??
        filtered.find((f) => f.name.startsWith("Generic")) ??
        filtered[0];
      setFilament(basic.name);
    }
  };

  const handleVariantChange = (variant: string) => {
    setVariantFilter(variant);
    const filtered = filaments
      .filter((f) => materialType(f.name) === materialFilter)
      .filter((f) => materialVariant(f.name) === variant);
    if (filtered.length > 0 && !filtered.some((f) => f.name === filament)) {
      const basic =
        filtered.find((f) => f.name.includes("Basic")) ??
        filtered.find((f) => f.name.startsWith("Generic")) ??
        filtered[0];
      setFilament(basic.name);
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
        // Default to PLA material filter
        const types = [...new Set(data.map((f) => materialType(f.name)))];
        const defaultType = types.includes("PLA") ? "PLA" : types[0] ?? "";
        setMaterialFilter(defaultType);
        // Default to Standard variant
        const ofType = data.filter(
          (f) => materialType(f.name) === defaultType,
        );
        const variants = [
          ...new Set(ofType.map((f) => materialVariant(f.name))),
        ];
        const defaultVariant = variants.includes("Standard")
          ? "Standard"
          : variants[0] ?? "";
        setVariantFilter(defaultVariant);
        // Auto-select a default filament from the filtered material + variant
        const filtered = ofType.filter(
          (f) => materialVariant(f.name) === defaultVariant,
        );
        if (filtered.length > 0 && !filtered.some((f) => f.name === filament)) {
          const basic =
            filtered.find((f) => f.name.includes("Basic")) ??
            filtered.find((f) => f.name.startsWith("Generic")) ??
            filtered[0];
          setFilament(basic.name);
        }
      })
      .catch(() => {});
  }, [resolvedMachine]);

  // Fetch resolved config when profile selections change
  useEffect(() => {
    if (!resolvedMachine || !process || !filament) {
      setResolvedConfig(null);
      return;
    }
    const params = new URLSearchParams({
      machine: resolvedMachine,
      process,
      filament,
    });
    fetch(`/api/profiles/resolve?${params}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setResolvedConfig(data))
      .catch(() => setResolvedConfig(null));
  }, [resolvedMachine, process, filament]);

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
    if (color) formData.append("color", color);
    if (Object.keys(overrides).length > 0) {
      formData.append("overrides", JSON.stringify(overrides));
    }

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
    color,
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
            Material
            <select
              value={materialFilter}
              onChange={(e) => handleMaterialChange(e.target.value)}
              disabled={!resolvedMachine}
            >
              {materialTypes.length === 0 ? (
                <option>
                  {resolvedMachine
                    ? "Loading..."
                    : printers.length === 0
                      ? "Add a printer first"
                      : "Select printer first"}
                </option>
              ) : (
                <>
                  <option value="">All materials</option>
                  {materialTypes.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </>
              )}
            </select>
          </label>

          {availableVariants.length > 1 && (
            <label>
              Variant
              <select
                value={variantFilter}
                onChange={(e) => handleVariantChange(e.target.value)}
              >
                {availableVariants.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label>
            Filament
            <select
              value={filament}
              onChange={(e) => setFilament(e.target.value)}
              disabled={!resolvedMachine}
            >
              {filteredFilaments.length === 0 ? (
                <option>
                  {resolvedMachine
                    ? "Loading..."
                    : printers.length === 0
                      ? "Add a printer first"
                      : "Select printer first"}
                </option>
              ) : (
                filteredFilaments.map((f) => (
                  <option key={f.name} value={f.name}>
                    {filamentDisplayName(f.name)}
                  </option>
                ))
              )}
            </select>
          </label>

          <label>
            Color
            <input
              type="text"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              placeholder="Any / not specified"
              disabled={!resolvedMachine}
            />
          </label>

          <OverridesPanel
            resolvedConfig={resolvedConfig}
            overrides={overrides}
            onChange={setOverrides}
            disabled={!resolvedMachine}
          />

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
