import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useSearchParams } from "react-router";
import ModelViewer, { type BedShape, type PlateState, type SupportCheck } from "../components/ModelViewer";
import SupportsPanel, { type SupportSettings } from "../components/SupportsPanel";
import SliceResult from "../components/SliceResult";
import OverridesPanel from "../components/OverridesPanel";
import {
  BrowserEngine,
  browserSupportsEngine,
  canRunThreaded,
  loadManifest,
  pickVariant,
} from "../engine/client";
import type { EngineManifest, PlateLayout, SliceOptions } from "../engine/types";
import { useJson } from "../api";
import { BED_TYPES, loadedTrays, type PrinterStatus } from "../printers";
import {
  defaultSupportMaterials,
  materialsFromJob,
  supportFilaments,
  type FilamentOption,
  type SupportMaterials,
} from "../supports";
import { loadLocalModel, saveLocalModel } from "../localModels";

/** Where slicing runs. "auto" uses the browser engine when the server is busy. */
type ComputeMode = "auto" | "server" | "browser";
const COMPUTE_KEY = "farmslicer.compute";
/** The group jobs are charged to, remembered per browser. */
const GROUP_KEY = "farmslicer.group";
/** Browser slices keep the model in this browser instead of uploading it. */
const KEEP_LOCAL_KEY = "farmslicer.keepLocal";

interface MeGroups {
  chargeable: { id: string; path: string }[];
}

interface ServerStatus {
  server_active_jobs: number;
  slicer_busy: boolean;
  cpus: number;
  browser_engine_available: boolean;
}

interface JobRecord {
  id: string;
  config_json: string | null;
  /** Browser jobs: what to produce besides G-code (server-decided). */
  slice_options?: Omit<SliceOptions, "logo"> & { logo_url: string | null };
}

/** Decode the group logo to RGBA for the engine's thumbnail overlay. */
async function loadLogo(url: string): Promise<SliceOptions["logo"]> {
  try {
    const res = await fetch(url);
    if (!res.ok) return undefined;
    const bitmap = await createImageBitmap(await res.blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    return { rgba: data.data.buffer.slice(0) as ArrayBuffer, width: bitmap.width, height: bitmap.height };
  } catch {
    return undefined;
  }
}

/** The bed from a resolved profile: `printable_area` ("0x0", ...) and `printable_height`. */
function bedFromConfig(config: Record<string, unknown> | null): BedShape | null {
  if (!config) return null;
  const raw = config.printable_area;
  const points = (Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [])
    .map((p) => String(p).split("x").map(Number))
    .filter((p): p is [number, number] => p.length === 2 && p.every(Number.isFinite));
  if (points.length < 3) return null;
  const height = Number(Array.isArray(config.printable_height) ? config.printable_height[0] : config.printable_height);
  return { area: points, height: Number.isFinite(height) && height > 0 ? height : 0 };
}

function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

interface Printer {
  id: string;
  name: string;
  machine_profile: string;
  nozzle_diameter: string;
  plate_type: string;
}

interface MachineModel {
  name: string;
  vendor_display: string;
  nozzle_diameters: string[];
  /** Nozzle size → the machine profile slicing uses for it. */
  variants: Record<string, string>;
}

/** The machine profile a printer slices with: its model at its nozzle size. */
function printerProfile(p: Printer, models: MachineModel[]): string {
  if (!p.nozzle_diameter) return p.machine_profile;
  return (
    models.find((m) => m.name === p.machine_profile)?.variants[p.nozzle_diameter] ??
    `${p.machine_profile} ${p.nozzle_diameter} nozzle`
  );
}

/** What re-slicing reads from GET /api/jobs/{id}. */
interface ResliceJob {
  model_name: string;
  overrides_json: string | null;
  models: { idx: number; name: string; sha256: string | null; stored: boolean }[];
  inputs: {
    machine: string;
    process: string;
    filaments: string[];
    bed_type: string;
    printer_id: string | null;
    routing: string;
    color: string;
    group_id: string | null;
  } | null;
  plate: PlateLayout | null;
}

interface ProfileEntry extends FilamentOption {
  description?: string;
}

/** Overrides the Supports section owns (Quick Settings leaves them out). */
const SUPPORT_KEYS = [
  "enable_support",
  "support_type",
  "support_on_build_plate_only",
  "support_filament",
  "support_interface_filament",
];

/**
 * The filament to offer from a list: the machine maker's own "Basic" line
 * (Bambu PLA Basic on a Bambu printer, not another brand's), then any
 * "Basic", then a generic one, then the first.
 */
function pickDefaultFilament(list: ProfileEntry[], maker: string): ProfileEntry | undefined {
  const own = (f: ProfileEntry) => maker !== "" && f.name.startsWith(`${maker} `);
  return (
    list.find((f) => own(f) && /\bBasic\b/.test(f.name)) ??
    list.find((f) => /\bBasic\b/.test(f.name)) ??
    list.find((f) => f.name.startsWith("Generic")) ??
    list[0]
  );
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
  // What's on the plate (the viewer's): model files, parts, whether they fit.
  const [layout, setLayout] = useState<PlateState | null>(null);
  const modelFiles = useMemo(() => layout?.files ?? [], [layout]);
  const [slicing, setSlicing] = useState(false);
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [printersLoaded, setPrintersLoaded] = useState(false);
  const [processes, setProcesses] = useState<ProfileEntry[]>([]);
  const [filaments, setFilaments] = useState<ProfileEntry[]>([]);
  const [printerId, setPrinterId] = useState("");
  const [machineModels, setMachineModels] = useState<MachineModel[]>([]);
  const [modelChoice, setModelChoice] = useState("");
  const [nozzleChoice, setNozzleChoice] = useState("");
  const [plateChoice, setPlateChoice] = useState("");
  const [process, setProcess] = useState("");
  const [filament, setFilament] = useState("");
  const [materialFilter, setMaterialFilter] = useState("");
  const [variantFilter, setVariantFilter] = useState("");
  const [color, setColor] = useState("");
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  // Supports: on by default (libslic3r only adds them where needed); the
  // support materials follow the part's filament unless the user picks.
  const [supports, setSupports] = useState<SupportSettings>({ enabled: true, type: null, buildPlateOnly: null });
  const [materialsChoice, setMaterialsChoice] = useState<{ part: string; value: SupportMaterials } | null>(null);
  const [supportCheck, setSupportCheck] = useState<SupportCheck | null>(null);
  // After slicing the page stays: the plate (Prepare) or the last slice
  // (Preview: the layers, warnings, sending it).
  const [sliced, setSliced] = useState<{ jobId: string; gcode?: Uint8Array } | null>(null);
  const [view, setView] = useState<"prepare" | "preview">("prepare");
  const statuses = useJson<PrinterStatus[]>("/api/printers/status").data;
  // What the page chose by itself (for the defaults-changed report).
  const proposedPicks = useRef<{ process?: string; filament?: string }>({});
  const [resolvedConfig, setResolvedConfig] = useState<Record<string, string> | null>(null);
  const [routing, setRouting] = useState("auto");
  const [groupChoice, setGroupChoice] = useState(() => localStorage.getItem(GROUP_KEY) ?? "");
  const me = useJson<MeGroups>("/api/me").data;
  const chargeable = me?.chargeable ?? [];
  // A remembered group the user has since left falls back to personal.
  const groupId = chargeable.some((g) => g.id === groupChoice) ? groupChoice : "";
  const [keepLocal, setKeepLocal] = useState(() => localStorage.getItem(KEEP_LOCAL_KEY) === "1");
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(
    null,
  );
  const [compute, setCompute] = useState<ComputeMode>(() => {
    const saved = localStorage.getItem(COMPUTE_KEY);
    return saved === "server" || saved === "browser" ? saved : "auto";
  });
  // undefined = still checking, null = no engine deployed
  const [engineManifest, setEngineManifest] = useState<EngineManifest | null | undefined>(undefined);
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null);
  const [progress, setProgress] = useState<{ percent: number; message: string } | null>(null);
  const [browserJobId, setBrowserJobId] = useState<string | null>(null);
  const engineRef = useRef<BrowserEngine | null>(null);

  useEffect(() => {
    fetch("/api/printers")
      .then((r) => r.json())
      .then((list: Printer[]) => {
        setPrinters(list);
        setPrintersLoaded(true);
      })
      .catch(() => setPrintersLoaded(true));
    fetch("/api/profiles/machine-models")
      .then((r) => r.json())
      .then(setMachineModels)
      .catch(() => {});
  }, []);

  useEffect(() => {
    localStorage.setItem(COMPUTE_KEY, compute);
  }, [compute]);

  // Is a browser engine deployed, and can this browser run it?
  useEffect(() => {
    loadManifest().then(setEngineManifest);
  }, []);

  // Server load, for the "auto" compute choice and the status line.
  useEffect(() => {
    const poll = () =>
      fetch("/api/status")
        .then((r) => (r.ok ? r.json() : null))
        .then((s) => setServerStatus(s))
        .catch(() => {});
    poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, []);

  // Drop the engine worker (and its memory) when leaving the page.
  useEffect(() => {
    return () => {
      engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, []);

  // Slicing a job again (/slice?from=<job>): its models, plate and choices.
  const [searchParams] = useSearchParams();
  const fromJob = searchParams.get("from");
  const [initialPlate, setInitialPlate] = useState<{ key: string; files: File[]; plate: PlateLayout | null } | null>(null);
  const [reslice, setReslice] = useState<{ name: string; error?: string } | null>(null);
  const machineModelsLoaded = machineModels.length > 0;
  useEffect(() => {
    if (!fromJob || !printersLoaded || !machineModelsLoaded) return;
    let stale = false;
    (async () => {
      const res = await fetch(`/api/jobs/${encodeURIComponent(fromJob)}`);
      const job: ResliceJob & { error?: string } = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(job.error ?? `HTTP ${res.status}`);
      if (stale) return;
      setReslice({ name: job.model_name });
      const files: File[] = [];
      for (const m of job.models) {
        if (m.stored) {
          const r = await fetch(`/api/jobs/${encodeURIComponent(fromJob)}/models/${m.idx}`);
          if (!r.ok) throw new Error(`${m.name}: HTTP ${r.status}`);
          files.push(new File([await r.blob()], m.name));
        } else {
          const local = m.sha256 ? await loadLocalModel(m.sha256) : null;
          if (!local) throw new Error(`${m.name} stayed in the browser that sliced this job; it isn't in this one.`);
          files.push(local);
        }
      }
      if (stale) return;
      const inputs = job.inputs;
      if (inputs) {
        const printer = printers.find((p) => p.id === inputs.printer_id);
        setPrinterId(printer ? printer.id : "");
        const owner = machineModels.find((m) => Object.values(m.variants).includes(inputs.machine));
        if (owner) {
          setModelChoice(owner.name);
          setNozzleChoice(Object.entries(owner.variants).find(([, v]) => v === inputs.machine)?.[0] ?? "");
        }
        if (inputs.process) setProcess(inputs.process);
        if (inputs.filaments[0]) setFilament(inputs.filaments[0]);
        if (inputs.bed_type) setPlateChoice(inputs.bed_type);
        setColor(inputs.color ?? "");
        if (inputs.routing) setRouting(inputs.routing);
        if (inputs.group_id) setGroupChoice(inputs.group_id);
      }
      const saved: Record<string, string> = (() => {
        try {
          return JSON.parse(job.overrides_json ?? "{}") ?? {};
        } catch {
          return {};
        }
      })();
      // Jobs from before the Supports section: supports as the profile had
      // them (off, for the vendors' processes) unless overridden.
      setSupports({
        enabled: saved.enable_support === "1",
        type: saved.support_type ?? null,
        buildPlateOnly: saved.support_on_build_plate_only === undefined ? null : saved.support_on_build_plate_only === "1",
      });
      if (inputs?.filaments[0])
        setMaterialsChoice({ part: inputs.filaments[0], value: materialsFromJob(inputs.filaments, saved) });
      setOverrides(Object.fromEntries(Object.entries(saved).filter(([k]) => !SUPPORT_KEYS.includes(k))));
      setInitialPlate({ key: fromJob, files, plate: job.plate });
    })().catch((err) => {
      if (!stale) setReslice((r) => ({ name: r?.name ?? "this job", error: err instanceof Error ? err.message : String(err) }));
    });
    return () => {
      stale = true;
    };
    // Load once per job; the setters and lists it reads are settled by then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromJob, printersLoaded, machineModelsLoaded]);

  const engineVariant = engineManifest ? pickVariant(engineManifest) : null;
  const browserAvailable =
    browserSupportsEngine() &&
    engineVariant !== null &&
    (engineVariant !== "mt" || canRunThreaded());

  const engineStatusText = useMemo(() => {
    if (engineManifest === undefined) return "Checking for a browser engine…";
    if (engineManifest === null) return "No browser engine is deployed on this server.";
    if (!browserSupportsEngine()) return "This browser can't run the slicing engine.";
    if (!engineVariant) return "The deployed engine has no usable build.";
    const mb = ((engineManifest.variants[engineVariant]?.bytes ?? 0) / 1024 / 1024).toFixed(0);
    if (engineVariant === "mt") {
      const threads = Math.max(2, Math.min(16, navigator.hardwareConcurrency || 4));
      return `Browser engine: OrcaSlicer ${engineManifest.orca}, multithreaded (${threads} threads), ${mb} MB download, cached after first use.`;
    }
    return `Browser engine: OrcaSlicer ${engineManifest.orca}, single-threaded${canRunThreaded() ? "" : " (page is not cross-origin isolated)"}, ${mb} MB download.`;
  }, [engineManifest, engineVariant]);

  // Resolve "auto" to a concrete target for this click.
  const chooseTarget = useCallback((): "server" | "browser" => {
    if (compute === "server") return "server";
    if (compute === "browser") return "browser";
    if (browserAvailable && serverStatus?.slicer_busy) return "browser";
    return "server";
  }, [compute, browserAvailable, serverStatus]);

  // Models to offer: those of the farm's printers, or every known model when
  // no printer is configured yet (slicing doesn't need a printer).
  const offeredModels = useMemo(() => {
    if (!printersLoaded) return [];
    const farm = new Set(printers.map((p) => p.machine_profile));
    const ofFarm = machineModels.filter((m) => farm.has(m.name));
    return ofFarm.length > 0 ? ofFarm : machineModels;
  }, [printers, printersLoaded, machineModels]);

  const selectedPrinter = printers.find((p) => p.id === printerId);
  const model = selectedPrinter?.machine_profile ?? (modelChoice || offeredModels[0]?.name || "");
  const modelInfo = machineModels.find((m) => m.name === model);
  const nozzleOptions = useMemo(
    () => (modelInfo ? modelInfo.nozzle_diameters.filter((n) => n in modelInfo.variants) : []),
    [modelInfo],
  );

  // Default nozzle for a model: what most of the farm's printers of that model
  // carry, else 0.4 mm, else the first size the model comes in.
  const defaultNozzle = useCallback(
    (name: string): string => {
      const info = machineModels.find((m) => m.name === name);
      const sizes = info ? info.nozzle_diameters.filter((n) => n in info.variants) : [];
      const counts = new Map<string, number>();
      for (const p of printers) {
        if (p.machine_profile === name && sizes.includes(p.nozzle_diameter)) {
          counts.set(p.nozzle_diameter, (counts.get(p.nozzle_diameter) ?? 0) + 1);
        }
      }
      const common = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
      return common ?? (sizes.includes("0.4") ? "0.4" : sizes[0] ?? "");
    },
    [machineModels, printers],
  );

  const nozzle = selectedPrinter
    ? selectedPrinter.nozzle_diameter
    : nozzleOptions.includes(nozzleChoice)
      ? nozzleChoice
      : defaultNozzle(model);

  // Build plate: the chosen printer's, else what most of the farm's printers
  // of this model carry, else textured PEI (what Bambu printers ship with).
  const plateCounts = new Map<string, number>();
  for (const p of printers)
    if (p.machine_profile === model && p.plate_type) plateCounts.set(p.plate_type, (plateCounts.get(p.plate_type) ?? 0) + 1);
  const defaultPlate = [...plateCounts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "Textured PEI Plate";
  const plate = selectedPrinter?.plate_type || plateChoice || defaultPlate;
  // The machine's maker, for default filaments ("Bambu" for Bambu Lab).
  const maker = (modelInfo?.vendor_display ?? "").split(" ")[0] ?? "";

  // The printers this job may go to, and what they have loaded.
  const targetStatuses = useMemo(() => {
    const all = statuses ?? [];
    if (selectedPrinter) return all.filter((st) => st.printer_id === selectedPrinter.id);
    const ofModel = new Set(printers.filter((p) => p.machine_profile === model).map((p) => p.id));
    return all.filter((st) => ofModel.has(st.printer_id));
  }, [statuses, selectedPrinter, printers, model]);
  const loadedMaterials = useMemo(
    () => new Set(targetStatuses.flatMap((st) => loadedTrays(st)).map((t) => (t.material ?? "").toUpperCase())),
    [targetStatuses],
  );
  // An AMS on any of them (no status yet: Bambu printers usually have one).
  const multiMaterial =
    targetStatuses.length > 0 ? targetStatuses.some((st) => st.ams.length > 0) : model.startsWith("Bambu Lab");
  const partFilament = filaments.find((f) => f.name === filament);
  const defaultMaterials = useMemo(
    () => defaultSupportMaterials(partFilament, filaments, { multiMaterial, loaded: loadedMaterials }),
    [partFilament, filaments, multiMaterial, loadedMaterials],
  );
  const supportMaterials = materialsChoice && materialsChoice.part === filament ? materialsChoice.value : defaultMaterials;
  const supportPlan = useMemo(
    () => supportFilaments(filament, supports.enabled, supportMaterials),
    [filament, supports.enabled, supportMaterials],
  );
  // The overrides the job goes out with: Quick Settings plus Supports.
  const jobOverrides = useMemo(() => {
    const o: Record<string, string> = { ...overrides, enable_support: supports.enabled ? "1" : "0" };
    if (supports.type) o.support_type = supports.type;
    if (supports.buildPlateOnly !== null) o.support_on_build_plate_only = supports.buildPlateOnly ? "1" : "0";
    if (supports.enabled) Object.assign(o, supportPlan.overrides);
    return o;
  }, [overrides, supports, supportPlan]);

  // The machine profile to slice with
  const resolvedMachine = selectedPrinter
    ? printerProfile(selectedPrinter, machineModels)
    : (modelInfo?.variants[nozzle] ?? "");

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

  // Keep the process and filament: when the printer's machine differs, the
  // profile reload below replaces choices that don't fit it. Clearing them
  // here left them empty when the machine stayed the same (the reload never
  // ran), and the job went out with no profiles.
  const handlePrinterChange = (id: string) => {
    setPrinterId(id);
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
      const basic = pickDefaultFilament(filtered, maker);
      if (basic) setFilament(basic.name);
    }
  };

  const handleVariantChange = (variant: string) => {
    setVariantFilter(variant);
    const filtered = filaments
      .filter((f) => materialType(f.name) === materialFilter)
      .filter((f) => materialVariant(f.name) === variant);
    if (filtered.length > 0 && !filtered.some((f) => f.name === filament)) {
      const basic = pickDefaultFilament(filtered, maker);
      if (basic) setFilament(basic.name);
    }
  };

  useEffect(() => {
    if (!resolvedMachine) {
      setProcesses([]);
      setFilaments([]);
      return;
    }
    // A slower answer for a machine chosen before must not overwrite the
    // current machine's profiles.
    let stale = false;
    fetch(
      `/api/profiles/processes?machine=${encodeURIComponent(resolvedMachine)}`,
    )
      .then((r) => r.json())
      .then((data: ProfileEntry[]) => {
        if (stale) return;
        setProcesses(data);
        if (data.length > 0 && !data.some((p) => p.name === process)) {
          const standard = data.find((p) => p.name.includes("0.20mm"));
          setProcess(standard?.name ?? data[0].name);
          proposedPicks.current.process = standard?.name ?? data[0].name;
        }
      })
      .catch(() => {});
    fetch(
      `/api/profiles/filaments?machine=${encodeURIComponent(resolvedMachine)}`,
    )
      .then((r) => r.json())
      .then((data: ProfileEntry[]) => {
        if (stale) return;
        setFilaments(data);
        // A filament this machine also has stays chosen (a job sliced
        // again, a nozzle change), with its material and variant; else PLA.
        const kept = data.find((f) => f.name === filament);
        const types = [...new Set(data.map((f) => materialType(f.name)))];
        const defaultType = kept ? materialType(kept.name) : types.includes("PLA") ? "PLA" : types[0] ?? "";
        setMaterialFilter(defaultType);
        // Default to Standard variant
        const ofType = data.filter(
          (f) => materialType(f.name) === defaultType,
        );
        const variants = [
          ...new Set(ofType.map((f) => materialVariant(f.name))),
        ];
        const defaultVariant = kept
          ? materialVariant(kept.name)
          : variants.includes("Standard")
            ? "Standard"
            : variants[0] ?? "";
        setVariantFilter(defaultVariant);
        // Auto-select a default filament from the filtered material + variant
        const filtered = ofType.filter(
          (f) => materialVariant(f.name) === defaultVariant,
        );
        if (filtered.length > 0 && !filtered.some((f) => f.name === filament)) {
          const basic = pickDefaultFilament(filtered, maker);
          if (basic) {
            setFilament(basic.name);
            proposedPicks.current.filament = basic.name;
          }
        } else if (kept) {
          proposedPicks.current.filament = kept.name;
        }
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
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

  // Fields common to both compute targets. The server resolves the profiles
  // into one merged config and stores it on the job; the browser path reads
  // it back from the job record so both engines slice from identical input.
  const buildJobForm = useCallback(() => {
    const formData = new FormData();
    formData.append("routing", routing);
    if (printerId) formData.append("printer_id", printerId);
    if (resolvedMachine) formData.append("machine", resolvedMachine);
    if (process) formData.append("process", process);
    if (filament) for (const f of supportPlan.filaments) formData.append("filament", f);
    if (plate) formData.append("bed_type", plate);
    if (color) formData.append("color", color);
    formData.append("overrides", JSON.stringify(jobOverrides));
    if (groupId) formData.append("group_id", groupId);
    if (layout) formData.append("plate", JSON.stringify(layout.plate));
    // What the page would have sent untouched: the defaults-changed report
    // compares it with what the job was made from.
    formData.append(
      "proposed",
      JSON.stringify({
        nozzle: defaultNozzle(model),
        bed_type: defaultPlate,
        process: proposedPicks.current.process ?? null,
        filament: proposedPicks.current.filament ?? null,
        filaments: supportFilaments(proposedPicks.current.filament ?? filament, true, defaultMaterials).filaments,
        supports: { enabled: true, type: null, build_plate_only: null, materials: defaultMaterials },
        overrides: {},
      }),
    );
    return formData;
  }, [routing, printerId, resolvedMachine, process, filament, plate, color, jobOverrides, groupId, layout, supportPlan, defaultNozzle, model, defaultPlate, defaultMaterials]);

  const sliceOnServer = useCallback(async () => {
    if (modelFiles.length === 0) return;
    const formData = buildJobForm();
    for (const f of modelFiles) formData.append("model", f);
    const res = await fetch("/api/jobs", { method: "POST", body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    setResult({ ok: true, message: "Slicing on the server" });
    setSliced({ jobId: data.id });
    setView("preview");
  }, [modelFiles, buildJobForm]);

  const sliceInBrowser = useCallback(async () => {
    if (modelFiles.length === 0) return;
    setProgress({ percent: 0, message: "Loading engine" });

    // Boot (or reuse) the engine first so a missing/broken engine fails
    // before a job record exists.
    if (!engineRef.current) engineRef.current = await BrowserEngine.create();
    const engine = engineRef.current;

    // Register the job. The model goes up with it (every job keeps its
    // model so it can be sliced again), or stays in this browser.
    const formData = buildJobForm();
    formData.append("source", "browser");
    if (keepLocal) {
      const local = [];
      for (const f of modelFiles) local.push({ name: f.name, bytes: f.size, sha256: await saveLocalModel(f) });
      formData.append("local_models", JSON.stringify(local));
    } else {
      for (const f of modelFiles) formData.append("model", f);
    }
    const res = await fetch("/api/jobs", { method: "POST", body: formData });
    const job: JobRecord & { error?: string } = await res.json();
    if (!res.ok) throw new Error(job.error ?? `HTTP ${res.status}`);
    setBrowserJobId(job.id);

    let lastPost = 0;
    const started = performance.now();
    try {
      let options: SliceOptions | undefined;
      if (job.slice_options) {
        const { logo_url, ...rest } = job.slice_options;
        options = { ...rest, logo: logo_url ? await loadLogo(logo_url) : undefined };
      }
      const out = await engine.slice(modelFiles, job.config_json ?? "{}", (percent, message) => {
        setProgress({ percent, message });
        const now = Date.now();
        if (now - lastPost > 750) {
          lastPost = now;
          fetch(`/api/jobs/${job.id}/progress`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ percent, message }),
          })
            .then((r) => {
              // 409: the job was cancelled from the Jobs page.
              if (r.status === 409) engine.cancel();
            })
            .catch(() => {});
        }
      }, options);

      setProgress({ percent: 100, message: "Uploading G-code" });
      const upload = new FormData();
      upload.append("gcode", new Blob([out.gcode], { type: "text/plain" }), `${job.id}.gcode`);
      upload.append("print_time_sec", String(out.report.stats.printTimeSec));
      upload.append("filament_used_g", String(out.report.stats.filamentG));
      upload.append("warnings", JSON.stringify(out.report.warnings));
      if (out.package) upload.append("package", new Blob([out.package]), `${job.id}.gcode.3mf`);
      const up = await fetch(`/api/jobs/${job.id}/result`, { method: "POST", body: upload });
      if (!up.ok) {
        const data = await up.json().catch(() => ({}));
        throw new Error(data.error ?? `upload failed (HTTP ${up.status})`);
      }
      const secs = ((performance.now() - started) / 1000).toFixed(1);
      setResult({
        ok: true,
        message: `Sliced in this browser in ${secs}s: ${out.report.stats.layers} layers, est. ${formatDuration(out.report.stats.printTimeSec)}, ${out.report.stats.filamentG.toFixed(1)} g`,
      });
      setSliced({ jobId: job.id, gcode: out.gcode });
      setView("preview");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "cancelled") {
        await fetch(`/api/jobs/${job.id}/cancel`, { method: "POST" }).catch(() => {});
      } else {
        await fetch(`/api/jobs/${job.id}/fail`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: message }),
        }).catch(() => {});
      }
      throw err;
    } finally {
      setBrowserJobId(null);
    }
  }, [modelFiles, buildJobForm, keepLocal]);

  const handleSlice = useCallback(async () => {
    if (modelFiles.length === 0) return;
    setSlicing(true);
    setResult(null);
    setProgress(null);

    try {
      const target = chooseTarget();
      if (target === "browser" && !browserAvailable) {
        throw new Error("The browser engine is not available here; choose Server.");
      }
      if (target === "browser") {
        await sliceInBrowser();
      } else {
        await sliceOnServer();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setResult({ ok: false, message: message === "cancelled" ? "Cancelled" : message });
    } finally {
      setSlicing(false);
      setProgress(null);
    }
  }, [modelFiles, chooseTarget, browserAvailable, sliceInBrowser, sliceOnServer]);

  const bed = useMemo(() => bedFromConfig(resolvedConfig), [resolvedConfig]);
  const profileValue = (key: string): string | undefined => {
    const v: unknown = resolvedConfig?.[key];
    return Array.isArray(v) ? String(v[0]) : v === undefined || v === null ? undefined : String(v);
  };
  const supportThreshold = Number(profileValue("support_threshold_angle")) || 0;
  const offBed = !!layout && (layout.fit !== "inside" || layout.overlaps);

  const handleCancelBrowserSlice = useCallback(() => {
    engineRef.current?.cancel();
  }, []);

  return (
    <div className="page slice-page">
      <h2>Slice</h2>
      <div className="slice-layout">
        <div className="viewer-panel">
          <div className="view-tabs" role="tablist">
            <button role="tab" aria-selected={view === "prepare"} className={view === "prepare" ? "active" : ""} onClick={() => setView("prepare")}>
              Prepare
            </button>
            <button
              role="tab"
              aria-selected={view === "preview"}
              className={view === "preview" ? "active" : ""}
              disabled={!sliced}
              title={sliced ? "The last slice: its layers, warnings, sending it" : "Slice something first"}
              onClick={() => setView("preview")}
            >
              Preview
            </button>
          </div>
          {/* The plate stays mounted under the preview: its parts survive. */}
          <div className="view-pane" hidden={view !== "prepare"}>
            <ModelViewer
              bed={bed}
              onPlateChange={setLayout}
              initial={initialPlate}
              supportThreshold={supportThreshold}
              supportsOn={supports.enabled}
              onSupportCheck={setSupportCheck}
            />
          </div>
          {sliced && view === "preview" && (
            <div className="view-pane">
              <SliceResult key={sliced.jobId} jobId={sliced.jobId} gcode={sliced.gcode} bed={bed} onBack={() => setView("prepare")} />
            </div>
          )}
        </div>
        <div className="settings-panel">
          <h3>Settings</h3>
          {reslice && (
            <p className={`hint reslice-note ${reslice.error ? "bad" : ""}`}>
              {reslice.error
                ? `Can't slice ${reslice.name} again: ${reslice.error}`
                : `Slicing ${reslice.name} again: its parts and settings are loaded. Change what you like; it becomes a new job.`}
            </p>
          )}

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

          <div className="machine-row">
            <label>
              Model
              <select
                value={model}
                disabled={!!selectedPrinter}
                onChange={(e) => {
                  setModelChoice(e.target.value);
                  setNozzleChoice("");
                }}
              >
                {selectedPrinter &&
                  !offeredModels.some((m) => m.name === selectedPrinter.machine_profile) && (
                    <option value={selectedPrinter.machine_profile}>
                      {selectedPrinter.machine_profile}
                    </option>
                  )}
                {[...new Set(offeredModels.map((m) => m.vendor_display))].map((vendor) => (
                  <optgroup key={vendor} label={vendor}>
                    {offeredModels
                      .filter((m) => m.vendor_display === vendor)
                      .map((m) => (
                        <option key={m.name} value={m.name}>
                          {m.name}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
            </label>
            <label>
              Nozzle
              <select
                value={nozzle}
                disabled={!!selectedPrinter || nozzleOptions.length < 2}
                onChange={(e) => setNozzleChoice(e.target.value)}
              >
                {selectedPrinter && !nozzleOptions.includes(nozzle) && (
                  <option value={nozzle}>{nozzle ? `${nozzle} mm` : "—"}</option>
                )}
                {nozzleOptions.map((n) => (
                  <option key={n} value={n}>
                    {n} mm
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label>
            Build plate
            <select
              value={plate}
              disabled={!!selectedPrinter?.plate_type}
              onChange={(e) => setPlateChoice(e.target.value)}
            >
              {BED_TYPES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {selectedPrinter && (
            <p className="hint">Model, nozzle and plate come from the selected printer.</p>
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

          <SupportsPanel
            settings={supports}
            onSettings={setSupports}
            materials={supportMaterials}
            onMaterials={(value) => setMaterialsChoice({ part: filament, value })}
            part={partFilament}
            filaments={filaments}
            profileType={profileValue("support_type")}
            profileBuildPlateOnly={profileValue("support_on_build_plate_only") === "1"}
            loaded={loadedMaterials}
            multiMaterial={multiMaterial}
            check={supportCheck}
            disabled={!resolvedMachine || slicing}
          />

          <OverridesPanel
            resolvedConfig={resolvedConfig}
            overrides={overrides}
            onChange={setOverrides}
            disabled={!resolvedMachine}
            processName={process}
            filamentName={filament}
            hiddenKeys={SUPPORT_KEYS}
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

          <label>
            Group
            <select
              value={groupId}
              onChange={(e) => {
                setGroupChoice(e.target.value);
                localStorage.setItem(GROUP_KEY, e.target.value);
              }}
              disabled={slicing}
            >
              <option value="">Personal (only you and admins see it)</option>
              {chargeable.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.path}
                </option>
              ))}
            </select>
          </label>

          <label>
            Compute
            <select
              value={compute}
              onChange={(e) => setCompute(e.target.value as ComputeMode)}
              disabled={slicing}
            >
              <option value="auto">Auto (this browser when the server is busy)</option>
              <option value="server">Server</option>
              <option value="browser" disabled={!browserAvailable}>
                This browser{browserAvailable ? "" : " (unavailable)"}
              </option>
            </select>
          </label>
          <p className="hint compute-status">
            {engineStatusText}
            {serverStatus && (
              <>
                {" "}
                Server: {serverStatus.server_active_jobs === 0
                  ? "idle"
                  : `${serverStatus.server_active_jobs} active job${serverStatus.server_active_jobs === 1 ? "" : "s"}`}
                {compute === "auto" && (
                  <> → will slice {chooseTarget() === "browser" ? "in this browser" : "on the server"}.</>
                )}
              </>
            )}
          </p>
          {compute !== "server" && (
            <label className="check-row">
              <input
                type="checkbox"
                checked={keepLocal}
                disabled={slicing}
                onChange={(e) => {
                  setKeepLocal(e.target.checked);
                  localStorage.setItem(KEEP_LOCAL_KEY, e.target.checked ? "1" : "0");
                }}
              />
              Keep the model on this device only
            </label>
          )}
          {compute !== "server" && keepLocal && (
            <p className="hint">
              Browser slices keep the model in this browser; the job is tagged local and can be
              sliced again only here. Server slices always upload it.
            </p>
          )}

          {layout && (
            <div className="model-info">
              <p>
                {modelFiles.length === 1 ? modelFiles[0].name : `${modelFiles.length} models`}
                {layout.plate.objects.length > 1 && ` · ${layout.plate.objects.length} parts`}
              </p>
              <p className="hint">
                {(modelFiles.reduce((sum, f) => sum + f.size, 0) / 1024 / 1024).toFixed(1)} MB
              </p>
            </div>
          )}

          {progress && (
            <div className="slice-progress">
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${progress.percent}%` }} />
              </div>
              <p className="hint">
                {progress.percent}% · {progress.message}
                {browserJobId && (
                  <>
                    {" "}
                    <button className="btn-sm" onClick={handleCancelBrowserSlice}>
                      Cancel
                    </button>
                  </>
                )}
              </p>
            </div>
          )}

          <button
            className="btn-primary"
            disabled={modelFiles.length === 0 || slicing || offBed}
            onClick={handleSlice}
          >
            {slicing ? (progress ? "Slicing in browser…" : "Submitting…") : "Slice"}
          </button>
          {offBed && (
            <p className="hint" style={{ marginTop: "0.5rem", color: "var(--error)" }}>
              {layout?.overlaps && layout.fit === "inside"
                ? "Move the parts apart (or Arrange them) to slice them."
                : "Move the parts inside the build plate to slice them."}
            </p>
          )}

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
