import { NavLink, Outlet } from "react-router";
import { useAuth } from "../auth";

const navItems = [
  { to: "/", label: "Printers" },
  { to: "/slice", label: "Slice" },
  { to: "/jobs", label: "Jobs" },
  { to: "/prints", label: "Prints" },
  { to: "/profiles", label: "Profiles" },
  { to: "/library", label: "Library" },
  { to: "/groups", label: "Groups" },
];

const adminItems = [
  { to: "/users", label: "Users" },
  { to: "/settings", label: "Settings" },
];

export default function Layout() {
  const { user, isAdmin, status, logout } = useAuth();
  const items = isAdmin ? [...navItems, ...adminItems] : navItems;

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="sidebar-header">
          <h1>FarmSlicer</h1>
        </div>
        <ul className="nav-list">
          {items.map((item) => (
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
        <div className="sidebar-user">
          {status?.auth_disabled ? (
            <span className="hint" title="FARMSLICER_NO_AUTH is set on the server">
              auth disabled
            </span>
          ) : (
            <>
              <NavLink to="/account" className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}>
                {user?.username ?? "account"}
                <span className="hint"> · {user?.kind === "guest" ? "guest" : user?.role}</span>
              </NavLink>
              <button className="btn-sm" onClick={() => logout()}>
                Log out
              </button>
            </>
          )}
        </div>
      </nav>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
