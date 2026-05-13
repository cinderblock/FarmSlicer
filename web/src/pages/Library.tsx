export default function LibraryPage() {
  // TODO: fetch from /api/slices
  const slices: {
    id: string;
    modelName: string;
    createdAt: string;
    printTime: string;
    filamentUsed: string;
    fileSize: string;
  }[] = [];

  return (
    <div className="page">
      <h2>Slice Library</h2>
      {slices.length === 0 ? (
        <p className="empty-state">
          No slices yet. Completed slice jobs will appear here.
        </p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Model</th>
              <th>Date</th>
              <th>Print Time</th>
              <th>Filament</th>
              <th>Size</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {slices.map((s) => (
              <tr key={s.id}>
                <td>{s.modelName}</td>
                <td>{s.createdAt}</td>
                <td>{s.printTime}</td>
                <td>{s.filamentUsed}</td>
                <td>{s.fileSize}</td>
                <td>
                  <button className="btn-sm">Print</button>
                  <button className="btn-sm">Download</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
