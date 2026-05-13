export default function PrintersPage() {
  // TODO: fetch from /api/printers
  const printers: {
    id: string;
    name: string;
    status: string;
    protocol: string;
    currentJob: string | null;
  }[] = [];

  return (
    <div className="page">
      <h2>Printers</h2>
      <div className="page-actions">
        <button className="btn-primary">Add Printer</button>
      </div>
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
              {printer.currentJob ? (
                <p>Printing: {printer.currentJob}</p>
              ) : (
                <p className="hint">Idle</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
