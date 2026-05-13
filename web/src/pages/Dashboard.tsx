import { Link } from "react-router";

export default function Dashboard() {
  return (
    <div className="page">
      <h2>Dashboard</h2>
      <div className="card-grid">
        <Link to="/slice" className="card">
          <h3>Slice</h3>
          <p>Upload a model and start slicing</p>
        </Link>
        <Link to="/jobs" className="card">
          <h3>Jobs</h3>
          <p>View queued and active slice jobs</p>
        </Link>
        <Link to="/printers" className="card">
          <h3>Printers</h3>
          <p>Monitor printer status</p>
        </Link>
        <Link to="/library" className="card">
          <h3>Library</h3>
          <p>Browse past slices</p>
        </Link>
      </div>
    </div>
  );
}
