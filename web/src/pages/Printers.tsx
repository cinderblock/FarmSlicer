import { useState, useEffect, useCallback } from "react";

interface Printer {
  id: string;
  name: string;
  status: string;
  protocol: string;
  address: string;
  current_job: string | null;
}

export default function PrintersPage() {
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [protocol, setProtocol] = useState("bambu");
  const [address, setAddress] = useState("");

  const fetchPrinters = useCallback(async () => {
    const res = await fetch("/api/printers");
    setPrinters(await res.json());
  }, []);

  useEffect(() => {
    fetchPrinters();
  }, [fetchPrinters]);

  const handleAdd = async () => {
    if (!name.trim()) return;
    await fetch("/api/printers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, protocol, address }),
    });
    setName("");
    setAddress("");
    setShowForm(false);
    fetchPrinters();
  };

  const handleDelete = async (id: string) => {
    await fetch(`/api/printers/${id}`, { method: "DELETE" });
    fetchPrinters();
  };

  return (
    <div className="page">
      <h2>Printers</h2>
      <div className="page-actions">
        <button className="btn-primary" onClick={() => setShowForm(!showForm)}>
          {showForm ? "Cancel" : "Add Printer"}
        </button>
      </div>

      {showForm && (
        <div className="card" style={{ marginBottom: "1rem", maxWidth: 400 }}>
          <label>
            Name
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Printer"
              className="form-input"
            />
          </label>
          <label>
            Protocol
            <select
              value={protocol}
              onChange={(e) => setProtocol(e.target.value)}
              className="form-input"
            >
              <option value="bambu">Bambu Lab</option>
              <option value="octoprint">OctoPrint</option>
              <option value="klipper">Klipper / Moonraker</option>
            </select>
          </label>
          <label>
            Address
            <input
              type="text"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="192.168.1.100"
              className="form-input"
            />
          </label>
          <button
            className="btn-primary"
            onClick={handleAdd}
            style={{ marginTop: "0.5rem" }}
          >
            Save Printer
          </button>
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
              <p className="hint">{printer.protocol}</p>
              {printer.address && (
                <p className="hint">{printer.address}</p>
              )}
              {printer.current_job ? (
                <p>Printing: {printer.current_job}</p>
              ) : (
                <p className="hint">Idle</p>
              )}
              <button
                className="btn-sm"
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
