import { useState, useEffect, useCallback } from "react";
import SearchSelect from "../components/SearchSelect";

interface Printer {
  id: string;
  name: string;
  machine_profile: string;
  status: string;
  protocol: string;
  address: string;
  serial_number: string;
  access_code: string;
  current_job: string | null;
}

interface ProfileEntry {
  name: string;
  vendor: string;
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
  const [machines, setMachines] = useState<ProfileEntry[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [machineProfile, setMachineProfile] = useState("");
  const [protocol, setProtocol] = useState("bambu");
  const [address, setAddress] = useState("");
  const [serialNumber, setSerialNumber] = useState("");
  const [accessCode, setAccessCode] = useState("");

  const fetchPrinters = useCallback(async () => {
    const res = await fetch("/api/printers");
    setPrinters(await res.json());
  }, []);

  useEffect(() => {
    fetchPrinters();
    fetch("/api/profiles/machines")
      .then((r) => r.json())
      .then(setMachines)
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

  const machineOptions = machines.map((m) => ({
    value: m.name,
    label: m.name,
    group: m.vendor,
  }));

  const resetForm = () => {
    setName("");
    setMachineProfile("");
    setProtocol("bambu");
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
        machine_profile: machineProfile,
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
    setMachineProfile(d.machine_profile);
    setProtocol("bambu");
    setAddress(d.ip);
    setSerialNumber(d.serial);
    setAccessCode("");
    setShowForm(true);
  };

  const isBambu = protocol === "bambu";

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
              Machine Profile
              <SearchSelect
                options={machineOptions}
                value={machineProfile}
                onChange={setMachineProfile}
                placeholder="Search machines..."
              />
            </label>

            <label>
              Protocol
              <select
                value={protocol}
                onChange={(e) => setProtocol(e.target.value)}
              >
                <option value="bambu">Bambu Lab (LAN)</option>
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

            {isBambu && (
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
                <p className="hint">{printer.machine_profile}</p>
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
