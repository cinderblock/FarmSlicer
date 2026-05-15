import { NavLink, Outlet } from "react-router";

const navItems = [
  { to: "/", label: "Printers" },
  { to: "/slice", label: "Slice" },
  { to: "/jobs", label: "Jobs" },
  { to: "/profiles", label: "Profiles" },
  { to: "/library", label: "Library" },
];

export default function Layout() {
  return (
    <div className="app">
      <nav className="sidebar">
        <div className="sidebar-header">
          <h1>FarmSlicer</h1>
        </div>
        <ul className="nav-list">
          {navItems.map((item) => (
            <li key={item.to}>
              <NavLink
                to={item.to}
                end={item.to === "/"}
                className={({ isActive }) =>
                  `nav-link ${isActive ? "active" : ""}`
                }
              >
                {item.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
