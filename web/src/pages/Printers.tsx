import { useState, useEffect, useMemo } from "react";
import { useAuth } from "../auth";
import { useJson } from "../api";
import PrinterCard from "../components/PrinterCard";
import { usePrinterStatuses, type Printer } from "../printers";

interface MachineModel {
  name: string;
  vendor: string;
  vendor_display: string;
  nozzle_diameters: string[];
}

interface DiscoveredPrinter {
  serial: string;
  name: string;
  model_code: string;
  model_name: string;
  machine_profile: string;
  ip: string;
  signal: string;
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
  const models = useMemo(() => modelsData ?? [], [modelsData]);
  const statuses = usePrinterStatuses();
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
        protocol:
          code === "BBL" ? "bambu" : code ? (d.protocol === "bambu" || !d.protocol ? "octoprint" : d.protocol) : d.protocol,
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
    // Discovery provides the full profile name (e.g., "Bambu Lab A1 0.4 nozzle").
    // Find the matching model and extract vendor + nozzle.
    const matchedModel = models.find((m) => d.machine_profile.startsWith(m.name));
    const nozzleMatch = matchedModel
      ? d.machine_profile.slice(matchedModel.name.length).trim().match(/^([\d.]+)\s*nozzle/)
      : null;
    setError("");
    setDraft({
      ...EMPTY,
      name: d.name,
      vendor: matchedModel?.vendor_display ?? "",
      model: matchedModel?.name ?? d.machine_profile,
      nozzle:
        nozzleMatch && matchedModel?.nozzle_diameters.includes(nozzleMatch[1])
          ? nozzleMatch[1]
          : defaultNozzle(matchedModel),
      protocol: "bambu",
      address: d.ip,
      serial: d.serial,
    });
  };

  const isBambuProtocol = draft?.protocol === "bambu";

  // Discovered printers not in the farm yet, and farm printers whose address
  // changed (DHCP) since they were added.
  const bySerial = new Map(
    printers.filter((p) => p.serial_number).map((p) => [p.serial_number as string, p]),
  );
  const newDiscovered = discovered.filter((d) => !bySerial.has(d.serial));
  const moved = discovered
    .map((d) => ({ d, p: bySerial.get(d.serial) }))
    .filter((x): x is { d: DiscoveredPrinter; p: Printer } => !!x.p && x.p.address !== x.d.ip);

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
                placeholder="Bambu X1C #1"
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
                {(isBambuVendor || draft.protocol === "bambu") && (
                  <option value="bambu">Bambu Lab (LAN)</option>
                )}
                <option value="octoprint">OctoPrint</option>
                <option value="klipper">Klipper / Moonraker</option>
              </select>
            </label>

            <label>
              IP Address
              <input
                type="text"
                value={draft.address}
                onChange={(e) => set({ address: e.target.value })}
                placeholder="192.168.1.100"
              />
            </label>

            {isBambuProtocol && (
              <>
                <label>
                  Serial Number
                  <input
                    type="text"
                    value={draft.serial}
                    onChange={(e) => set({ serial: e.target.value })}
                    placeholder="01P00A000000000"
                  />
                </label>
                <label>
                  Access Code
                  <input
                    type="password"
                    autoComplete="off"
                    value={draft.accessCode}
                    onChange={(e) => set({ accessCode: e.target.value })}
                    placeholder={
                      draft.accessCodeSet ? "Set (leave empty to keep it)" : "8-character code from the printer's screen"
                    }
                  />
                </label>
                <p className="hint">
                  The access code is on the printer's screen, in its network / LAN-only settings.
                  LAN mode and Developer Mode must be on for FarmSlicer to connect.
                </p>
              </>
            )}

            {error && <p className="printer-error">{error}</p>}
            <button className="btn-primary" onClick={handleSave} style={{ marginTop: "0.5rem" }}>
              {draft.id ? "Save" : "Add Printer"}
            </button>
          </div>
        </div>
      )}

      {isAdmin && moved.length > 0 && (
        <div className="discovered-section">
          <h3>Address Changed</h3>
          <div className="card-grid">
            {moved.map(({ d, p }) => (
              <div key={d.serial} className="card discovered-card">
                <h3>{p.name}</h3>
                <p className="hint">
                  Configured at {p.address || "no address"}, now announcing from {d.ip}.
                </p>
                <button className="btn-sm" style={{ marginTop: "0.5rem" }} onClick={() => handleUpdateAddress(p, d.ip)}>
                  Use {d.ip}
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
              <div key={d.serial} className="card discovered-card">
                <div className="printer-header">
                  <h3>{d.name || d.model_name}</h3>
                  <span className="pulse-dot" />
                </div>
                <p className="hint">{d.model_name}</p>
                <p className="hint">{d.ip}</p>
                <p className="hint">S/N: {d.serial}</p>
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
        <div className="card-grid printer-grid">
          {printers.map((printer) => (
            <PrinterCard
              key={printer.id}
              printer={printer}
              status={statuses[printer.id]}
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
      )}
    </div>
  );
}
