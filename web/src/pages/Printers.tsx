import { useState, useEffect, useMemo } from "react";
import { useAuth } from "../auth";
import { localDateTime, useJson } from "../api";
import PrinterCard from "../components/PrinterCard";
import { BED_TYPES, NOZZLE_PRIORITIES, useActivePrints, usePrinterStatuses, type Printer, type Protocol } from "../printers";

interface MachineModel {
  name: string;
  vendor: string;
  vendor_display: string;
  nozzle_diameters: string[];
  /** How many nozzles (2 on the H2D). */
  nozzles: number;
}

/** A printer seen on the LAN (src/discovery/). */
interface DiscoveredPrinter {
  /** The protocol to add it with. */
  protocol: string;
  /** What tells it apart (Bambu serial, SDCP mainboard id, mDNS instance). */
  id: string;
  /** For the serial number field; "" when the protocol has none. */
  serial: string;
  name: string;
  model_code: string;
  model_name: string;
  machine_profile: string;
  ip: string;
  /** For the address field (may carry a port). */
  address: string;
  signal: string;
}

/** The host part of an address as typed or discovered. */
const hostOf = (address: string) =>
  address
    .trim()
    .replace(/^[a-z]+:\/\//, "")
    .split(/[/?]/)[0]
    .replace(/:\d+$/, "")
    .toLowerCase();

interface OpenReport {
  id: string;
  printer_id: string | null;
  printer_name: string;
  username: string | null;
  description: string;
  created_at: string;
}

/** The add/edit form's fields. `accessCode` empty on edit = keep the old one. */
interface Draft {
  id: string | null;
  name: string;
  vendor: string;
  model: string;
  nozzle: string;
  protocol: string;
  address: string;
  serial: string;
  accessCode: string;
  accessCodeSet: boolean;
  area: string;
  plateType: string;
  nozzlePriority: string;
}

const EMPTY: Draft = {
  id: null,
  name: "",
  vendor: "",
  model: "",
  nozzle: "",
  protocol: "",
  address: "",
  serial: "",
  accessCode: "",
  accessCodeSet: false,
  area: "",
  plateType: "Textured PEI Plate",
  nozzlePriority: "",
};

function defaultNozzle(m: MachineModel | undefined): string {
  if (!m) return "";
  return m.nozzle_diameters.find((n) => n === "0.4") ?? m.nozzle_diameters[0] ?? "";
}

export default function PrintersPage() {
  const { isAdmin } = useAuth();
  const [rev, setRev] = useState(0);
  const printersQuery = useJson<Printer[]>("/api/printers", rev);
  const printers = useMemo(() => printersQuery.data ?? [], [printersQuery.data]);
  const modelsData = useJson<MachineModel[]>("/api/profiles/machine-models").data;
  const protocols = useJson<Protocol[]>("/api/printer-protocols").data ?? [];
  const models = useMemo(() => modelsData ?? [], [modelsData]);
  const statuses = usePrinterStatuses();
  const activePrints = useActivePrints();
  const reports = useJson<OpenReport[]>(isAdmin ? "/api/printer-reports?open=1" : null, rev).data;
  const openReports = (id: string) => (reports ?? []).filter((r) => r.printer_id === id).length;
  // Cards by area (as entered), unnamed last.
  const areas = [...new Set(printers.map((p) => p.area))].sort((a, b) =>
    a === "" ? 1 : b === "" ? -1 : a.localeCompare(b, undefined, { numeric: true }),
  );
  const [discovered, setDiscovered] = useState<DiscoveredPrinter[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState("");

  // Poll for discovered printers
  useEffect(() => {
    const fetchDiscovered = () => {
      fetch("/api/discovery")
        .then((r) => r.json())
        .then(setDiscovered)
        .catch(() => {});
    };
    fetchDiscovered();
    const interval = setInterval(fetchDiscovered, 5000);
    return () => clearInterval(interval);
  }, []);

  const vendors = useMemo(() => {
    const v = [...new Set(models.map((m) => m.vendor_display))];
    v.sort();
    return v;
  }, [models]);

  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  const vendorModels = models.filter((m) => m.vendor_display === draft?.vendor);
  const isBambuVendor = vendorModels[0]?.vendor === "BBL";
  const nozzleOptions = models.find((m) => m.name === draft?.model)?.nozzle_diameters ?? [];

  const handleVendorChange = (vendor: string) => {
    const code = models.find((m) => m.vendor_display === vendor)?.vendor;
    setDraft((d) =>
      d && {
        ...d,
        vendor,
        model: "",
        nozzle: "",
        // Bambu printers speak only Bambu's protocol; for the rest the admin picks.
        protocol: code === "BBL" ? "bambu" : code && d.protocol === "bambu" ? "" : d.protocol,
      },
    );
  };

  const handleModelChange = (model: string) => {
    set({ model, nozzle: defaultNozzle(models.find((m) => m.name === model)) });
  };

  const startEdit = (p: Printer) => {
    setError("");
    setDraft({
      id: p.id,
      name: p.name,
      vendor: models.find((m) => m.name === p.machine_profile)?.vendor_display ?? "",
      model: p.machine_profile,
      nozzle: p.nozzle_diameter,
      protocol: p.protocol,
      address: p.address,
      serial: p.serial_number ?? "",
      accessCode: "",
      accessCodeSet: p.access_code_set,
      area: p.area,
      plateType: p.plate_type,
      nozzlePriority: p.nozzle_priority,
    });
  };

  const handleSave = async () => {
    if (!draft || !draft.name.trim()) return;
    const body: Record<string, string> = {
      name: draft.name,
      machine_profile: draft.model,
      nozzle_diameter: draft.nozzle,
      protocol: draft.protocol,
      address: draft.address,
      serial_number: draft.serial,
      area: draft.area,
      plate_type: draft.plateType,
      nozzle_priority: draft.nozzlePriority,
    };
    // Write-only: an empty field on edit keeps the stored code.
    if (draft.accessCode || !draft.id) body.access_code = draft.accessCode;
    const res = await fetch(draft.id ? `/api/printers/${draft.id}` : "/api/printers", {
      method: draft.id ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => null);
      setError(b?.error ?? `HTTP ${res.status}`);
      return;
    }
    setDraft(null);
    setError("");
    setRev((r) => r + 1);
  };

  const handleDelete = async (p: Printer) => {
    if (!confirm(`Remove ${p.name} from the farm?`)) return;
    await fetch(`/api/printers/${p.id}`, { method: "DELETE" });
    setRev((r) => r + 1);
  };

  const handleUpdateAddress = async (p: Printer, ip: string) => {
    await fetch(`/api/printers/${p.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: ip }),
    });
    setRev((r) => r + 1);
  };

  const handleAddDiscovered = (d: DiscoveredPrinter) => {
    // Discovery may name a profile ("Bambu Lab A1 0.4 nozzle") or a base model
    // ("Elegoo Centauri Carbon"); find the model and the nozzle in it. The
    // longest model name that fits wins ("Prusa MK4S" over "Prusa MK4").
    const matchedModel = d.machine_profile
      ? models
          .filter((m) => d.machine_profile.startsWith(m.name))
          .sort((a, b) => b.name.length - a.name.length)[0]
      : undefined;
    const nozzleMatch = matchedModel
      ? d.machine_profile.slice(matchedModel.name.length).trim().match(/^([\d.]+)\s*nozzle/)
      : null;
    setError("");
    setDraft({
      ...EMPTY,
      name: d.name,
      vendor: matchedModel?.vendor_display ?? "",
      model: matchedModel?.name ?? "",
      nozzle:
        nozzleMatch && matchedModel?.nozzle_diameters.includes(nozzleMatch[1])
          ? nozzleMatch[1]
          : defaultNozzle(matchedModel),
      protocol: d.protocol,
      address: d.address,
      serial: d.serial,
    });
  };

  const protocol = protocols.find((p) => p.id === draft?.protocol);
  // Bambu's protocol is for Bambu printers only; other makes can't use it.
  const protocolChoices = protocols.filter((p) => p.id !== "bambu" || isBambuVendor || draft?.protocol === "bambu");
  const fieldValue = (key: string) =>
    key === "address" ? draft?.address : key === "serial_number" ? draft?.serial : draft?.accessCode;
  const setField = (key: string, value: string) =>
    set(key === "address" ? { address: value } : key === "serial_number" ? { serial: value } : { accessCode: value });

  // Discovered printers not in the farm yet (by serial where the protocol
  // has one, else by address), and farm printers whose address changed
  // (DHCP) since they were added.
  const bySerial = new Map(
    printers.filter((p) => p.serial_number).map((p) => [p.serial_number as string, p]),
  );
  const hosts = new Set(printers.map((p) => hostOf(p.address)).filter(Boolean));
  const newDiscovered = discovered.filter((d) => (d.serial ? !bySerial.has(d.serial) : !hosts.has(hostOf(d.address))));
  const moved = discovered
    .map((d) => ({ d, p: d.serial ? bySerial.get(d.serial) : undefined }))
    .filter((x): x is { d: DiscoveredPrinter; p: Printer } => !!x.p && hostOf(x.p.address) !== hostOf(x.d.address));

  return (
    <div className="page">
      <h2>Printers</h2>
      {isAdmin && (
        <div className="page-actions">
          <button
            className="btn-primary"
            style={{ width: "auto" }}
            onClick={() => {
              setError("");
              setDraft(draft ? null : { ...EMPTY });
            }}
          >
            {draft ? "Cancel" : "Add Printer"}
          </button>
        </div>
      )}

      {draft && (
        <div className="card" style={{ marginBottom: "1.5rem", maxWidth: 480 }}>
          <div className="printer-form">
            <h3>{draft.id ? `Edit ${draft.name}` : "Add a printer"}</h3>
            <label>
              Name
              <input
                type="text"
                value={draft.name}
                onChange={(e) => set({ name: e.target.value })}
                placeholder="X1C #1"
              />
            </label>

            <label>
              Manufacturer
              <input
                type="text"
                list="vendor-list"
                value={draft.vendor}
                onChange={(e) => handleVendorChange(e.target.value)}
                placeholder="Type to search..."
              />
              <datalist id="vendor-list">
                {vendors.map((v) => (
                  <option key={v} value={v} />
                ))}
              </datalist>
            </label>

            {vendorModels.length > 0 && (
              <label>
                Printer Model
                <select value={draft.model} onChange={(e) => handleModelChange(e.target.value)}>
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
                <select value={draft.nozzle} onChange={(e) => set({ nozzle: e.target.value })}>
                  {nozzleOptions.map((n) => (
                    <option key={n} value={n}>
                      {n}mm
                    </option>
                  ))}
                </select>
              </label>
            )}

            <label>
              Protocol
              <select value={draft.protocol} onChange={(e) => set({ protocol: e.target.value })}>
                {!draft.protocol && <option value="">Select protocol...</option>}
                {protocolChoices.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
                {draft.protocol && !protocol && (
                  <option value={draft.protocol}>{draft.protocol} (not supported)</option>
                )}
              </select>
              <span className="hint">How FarmSlicer talks to the printer.</span>
            </label>

            <label>
              Build plate
              <select value={draft.plateType} onChange={(e) => set({ plateType: e.target.value })}>
                <option value="">Not set</option>
                {BED_TYPES.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <span className="hint">What's on the printer now; slicing defaults to it, sending checks it.</span>
            </label>

            {(() => {
              const m = models.find((x) => x.name === draft.model);
              return m && m.vendor === "BBL" && m.nozzles === 2 ? (
                <label>
                  Nozzle priority
                  <select
                    value={draft.nozzlePriority || "support-right"}
                    onChange={(e) => set({ nozzlePriority: e.target.value })}
                  >
                    {NOZZLE_PRIORITIES.map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <span className="hint">
                    Slicing puts a filament loaded on only one side's AMS on that side's nozzle first; this decides
                    the rest.
                  </span>
                </label>
              ) : null;
            })()}

            <label>
              Area
              <input
                type="text"
                list="area-list"
                value={draft.area}
                onChange={(e) => set({ area: e.target.value })}
                placeholder="e.g. Bay 1 (optional)"
              />
              <datalist id="area-list">
                {areas.filter(Boolean).map((a) => (
                  <option key={a} value={a} />
                ))}
              </datalist>
            </label>

            {protocol?.connection.fields.map((f) => (
              <label key={f.key}>
                {f.required ? f.label : `${f.label} (optional)`}
                <input
                  type={f.secret ? "password" : "text"}
                  autoComplete="off"
                  value={fieldValue(f.key) ?? ""}
                  onChange={(e) => setField(f.key, e.target.value)}
                  placeholder={f.secret && draft.accessCodeSet ? "Set (leave empty to keep it)" : f.placeholder}
                />
              </label>
            ))}
            {protocol && <p className="hint">{protocol.connection.hint}</p>}

            {error && <p className="printer-error">{error}</p>}
            <button className="btn-primary" onClick={handleSave} style={{ marginTop: "0.5rem" }}>
              {draft.id ? "Save" : "Add Printer"}
            </button>
          </div>
        </div>
      )}

      {isAdmin && (reports?.length ?? 0) > 0 && (
        <div className="card reports-panel">
          <h3>Problem reports</h3>
          {reports!.map((r) => (
            <div key={r.id} className="report-row">
              <div>
                <strong>{r.printer_name}</strong>: {r.description}
                <div className="hint">
                  {r.username ?? "someone"}, {localDateTime(r.created_at)}
                </div>
              </div>
              <button
                className="btn-sm"
                onClick={async () => {
                  await fetch(`/api/printer-reports/${r.id}/resolve`, { method: "POST" });
                  setRev((x) => x + 1);
                }}
              >
                Resolved
              </button>
            </div>
          ))}
        </div>
      )}

      {isAdmin && moved.length > 0 && (
        <div className="discovered-section">
          <h3>Address Changed</h3>
          <div className="card-grid">
            {moved.map(({ d, p }) => (
              <div key={`${d.protocol}:${d.id}`} className="card discovered-card">
                <h3>{p.name}</h3>
                <p className="hint">
                  Configured at {p.address || "no address"}, now announcing from {d.address}.
                </p>
                <button className="btn-sm" style={{ marginTop: "0.5rem" }} onClick={() => handleUpdateAddress(p, d.address)}>
                  Use {d.address}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {isAdmin && newDiscovered.length > 0 && (
        <div className="discovered-section">
          <h3>Detected on Network</h3>
          <div className="card-grid">
            {newDiscovered.map((d) => (
              <div key={`${d.protocol}:${d.id}`} className="card discovered-card">
                <div className="printer-header">
                  <h3>{d.name || d.model_name}</h3>
                  <span className="pulse-dot" />
                </div>
                <p className="hint">{d.model_name}</p>
                <p className="hint">{d.address}</p>
                {d.serial && <p className="hint">S/N: {d.serial}</p>}
                <button
                  className="btn-sm"
                  style={{ marginTop: "0.5rem" }}
                  onClick={() => handleAddDiscovered(d)}
                >
                  Add to Farm
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {printersQuery.data && printers.length === 0 && (!isAdmin || newDiscovered.length === 0) ? (
        <p className="empty-state">No printers configured yet.</p>
      ) : (
        areas.map((area) => (
          <section key={area} className="printer-area">
            {(areas.length > 1 || area) && <h3>{area || "Elsewhere"}</h3>}
            <div className="card-grid printer-grid">
              {printers
                .filter((p) => p.area === area)
                .map((printer) => (
                  <PrinterCard
                    key={printer.id}
                    printer={printer}
                    status={statuses[printer.id]}
                    print={activePrints[printer.id]}
                    isAdmin={isAdmin}
                    openReports={openReports(printer.id)}
                    actions={
                      isAdmin && (
                        <>
                          <button className="btn-sm" onClick={() => startEdit(printer)}>
                            Edit
                          </button>
                          <button className="btn-sm btn-danger" onClick={() => handleDelete(printer)}>
                            Remove
                          </button>
                        </>
                      )
                    }
                  />
                ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
