import { useState, useEffect, useCallback, useMemo } from "react";

interface Printer {
  id: string;
  name: string;
  machine_profile: string;
  nozzle_diameter: string;
  status: string;
  protocol: string;
  address: string;
  serial_number: string;
  access_code: string;
  current_job: string | null;
}

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

export default function PrintersPage() {
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [discovered, setDiscovered] = useState<DiscoveredPrinter[]>([]);
  const [models, setModels] = useState<MachineModel[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [selectedVendor, setSelectedVendor] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [selectedNozzle, setSelectedNozzle] = useState("");
  const [protocol, setProtocol] = useState("");
  const [address, setAddress] = useState("");
  const [serialNumber, setSerialNumber] = useState("");
  const [accessCode, setAccessCode] = useState("");

  const fetchPrinters = useCallback(async () => {
    const res = await fetch("/api/printers");
    setPrinters(await res.json());
  }, []);

  useEffect(() => {
    fetchPrinters();
    fetch("/api/profiles/machine-models")
      .then((r) => r.json())
      .then(setModels)
      .catch(() => {});
  }, [fetchPrinters]);

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

  const vendorModels = useMemo(
    () => models.filter((m) => m.vendor_display === selectedVendor),
    [models, selectedVendor],
  );

  const vendorCode = useMemo(() => {
    return models.find((m) => m.vendor_display === selectedVendor)?.vendor ?? "";
  }, [models, selectedVendor]);

  const isBambuVendor = vendorCode === "BBL";

  const currentModel = models.find((m) => m.name === selectedModel);
  const nozzleOptions = currentModel?.nozzle_diameters ?? [];

  const handleVendorChange = (vendor: string) => {
    setSelectedVendor(vendor);
    setSelectedModel("");
    setSelectedNozzle("");
    const code = models.find((m) => m.vendor_display === vendor)?.vendor;
    if (code === "BBL") {
      setProtocol("bambu");
    } else if (code) {
      setProtocol((prev) => (prev === "bambu" || !prev) ? "octoprint" : prev);
    }
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

  const resetForm = () => {
    setName("");
    setSelectedVendor("");
    setSelectedModel("");
    setSelectedNozzle("");
    setProtocol("");
    setAddress("");
    setSerialNumber("");
    setAccessCode("");
    setShowForm(false);
  };

  const handleAdd = async () => {
    if (!name.trim()) return;
    await fetch("/api/printers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        machine_profile: selectedModel,
        nozzle_diameter: selectedNozzle,
        protocol,
        address,
        serial_number: serialNumber,
        access_code: accessCode,
      }),
    });
    resetForm();
    fetchPrinters();
  };

  const handleDelete = async (id: string) => {
    await fetch(`/api/printers/${id}`, { method: "DELETE" });
    fetchPrinters();
  };

  const handleAddDiscovered = (d: DiscoveredPrinter) => {
    setName(d.name);
    // Discovery provides the full profile name (e.g., "Bambu Lab A1 0.4 nozzle").
    // Find the matching model and extract vendor + nozzle.
    const matchedModel = models.find((m) =>
      d.machine_profile.startsWith(m.name),
    );
    if (matchedModel) {
      setSelectedVendor(matchedModel.vendor_display);
      setSelectedModel(matchedModel.name);
      const suffix = d.machine_profile.slice(matchedModel.name.length).trim();
      const nozzleMatch = suffix.match(/^([\d.]+)\s*nozzle/);
      if (
        nozzleMatch &&
        matchedModel.nozzle_diameters.includes(nozzleMatch[1])
      ) {
        setSelectedNozzle(nozzleMatch[1]);
      } else {
        setSelectedNozzle(
          matchedModel.nozzle_diameters.find((n) => n === "0.4") ??
            matchedModel.nozzle_diameters[0] ??
            "",
        );
      }
    } else {
      setSelectedVendor("");
      setSelectedModel(d.machine_profile);
      setSelectedNozzle("");
    }
    setProtocol("bambu");
    setAddress(d.ip);
    setSerialNumber(d.serial);
    setAccessCode("");
    setShowForm(true);
  };

  const isBambuProtocol = protocol === "bambu";

  // Filter out already-configured printers from discovered list
  const configuredSerials = new Set(
    printers.map((p) => p.serial_number).filter(Boolean),
  );
  const newDiscovered = discovered.filter(
    (d) => !configuredSerials.has(d.serial),
  );

  return (
    <div className="page">
      <h2>Printers</h2>
      <div className="page-actions">
        <button
          className="btn-primary"
          style={{ width: "auto" }}
          onClick={() => setShowForm(!showForm)}
        >
          {showForm ? "Cancel" : "Add Printer"}
        </button>
      </div>

      {showForm && (
        <div className="card" style={{ marginBottom: "1.5rem", maxWidth: 480 }}>
          <div className="printer-form">
            <label>
              Name
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Bambu X1C #1"
              />
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
              Protocol
              <select
                value={protocol}
                onChange={(e) => setProtocol(e.target.value)}
              >
                {!protocol && <option value="">Select protocol...</option>}
                {isBambuVendor && (
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
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="192.168.1.100"
              />
            </label>

            {isBambuProtocol && (
              <>
                <label>
                  Serial Number
                  <input
                    type="text"
                    value={serialNumber}
                    onChange={(e) => setSerialNumber(e.target.value)}
                    placeholder="01P00A000000000"
                  />
                </label>
                <label>
                  Access Code
                  <input
                    type="text"
                    value={accessCode}
                    onChange={(e) => setAccessCode(e.target.value)}
                    placeholder="8-digit code from printer"
                  />
                </label>
              </>
            )}

            <button
              className="btn-primary"
              onClick={handleAdd}
              style={{ marginTop: "0.5rem" }}
            >
              Add Printer
            </button>
          </div>
        </div>
      )}

      {newDiscovered.length > 0 && (
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

      {printers.length === 0 && newDiscovered.length === 0 ? (
        <p className="empty-state">No printers configured yet.</p>
      ) : printers.length === 0 ? null : (
        <div className="card-grid">
          {printers.map((printer) => (
            <div key={printer.id} className="card printer-card">
              <div className="printer-header">
                <h3>{printer.name}</h3>
                <span className={`status-dot status-${printer.status}`} />
              </div>
              {printer.machine_profile && (
                <p className="hint">
                  {printer.machine_profile}
                  {printer.nozzle_diameter &&
                    ` (${printer.nozzle_diameter}mm nozzle)`}
                </p>
              )}
              <p className="hint">
                {printer.protocol === "bambu"
                  ? "Bambu Lab (LAN)"
                  : printer.protocol}
              </p>
              {printer.address && <p className="hint">{printer.address}</p>}
              {printer.current_job ? (
                <p>Printing: {printer.current_job}</p>
              ) : (
                <p className="hint">Idle</p>
              )}
              <button
                className="btn-sm btn-danger"
                style={{ marginTop: "0.5rem" }}
                onClick={() => handleDelete(printer.id)}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
