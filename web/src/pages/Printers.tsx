import { useState, useEffect, useCallback } from "react";

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

export default function PrintersPage() {
  const [printers, setPrinters] = useState<Printer[]>([]);
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

  const groupByVendor = (entries: ProfileEntry[]) => {
    const groups: Record<string, ProfileEntry[]> = {};
    for (const e of entries) {
      (groups[e.vendor] ??= []).push(e);
    }
    return groups;
  };

  const isBambu = protocol === "bambu";

  return (
    <div className="page">
      <h2>Printers</h2>
      <div className="page-actions">
        <button className="btn-primary" style={{ width: "auto" }} onClick={() => setShowForm(!showForm)}>
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
              <select
                value={machineProfile}
                onChange={(e) => setMachineProfile(e.target.value)}
              >
                <option value="">Select machine...</option>
                {Object.entries(groupByVendor(machines)).map(
                  ([vendor, entries]) => (
                    <optgroup key={vendor} label={vendor}>
                      {entries.map((m) => (
                        <option key={m.name} value={m.name}>
                          {m.name}
                        </option>
                      ))}
                    </optgroup>
                  ),
                )}
              </select>
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

            <button className="btn-primary" onClick={handleAdd} style={{ marginTop: "0.5rem" }}>
              Add Printer
            </button>
          </div>
        </div>
      )}

      {printers.length === 0 ? (
        <p className="empty-state">No printers configured yet.</p>
      ) : (
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
              <p className="hint">{printer.protocol === "bambu" ? "Bambu Lab (LAN)" : printer.protocol}</p>
              {printer.address && (
                <p className="hint">{printer.address}</p>
              )}
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
