import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import { useAuth } from "../auth";
import { useJson } from "../api";
import { FEEDBACK_CHANGED, newCount, prefillFor, type Counts, type FeedbackPrefill } from "../feedback";
import ErrorBoundary from "./ErrorBoundary";
import FeedbackDialog from "./FeedbackDialog";

const navItems = [
  { to: "/", label: "Printers" },
  { to: "/slice", label: "Slice" },
  { to: "/jobs", label: "Jobs" },
  { to: "/prints", label: "Prints" },
  { to: "/profiles", label: "Profiles" },
  { to: "/library", label: "Library" },
  { to: "/groups", label: "Groups" },
  { to: "/guide", label: "Guide" },
];

const adminItems = [
  { to: "/users", label: "Users" },
  { to: "/feedback", label: "Feedback" },
  { to: "/settings", label: "Settings" },
];

/** How often admins' sidebar checks for new feedback. */
const FEEDBACK_POLL_MS = 60_000;

export default function Layout() {
  const { user, isAdmin, status, logout } = useAuth();
  const location = useLocation();
  const items = isAdmin ? [...navItems, ...adminItems] : navItems;
  const [feedback, setFeedback] = useState<FeedbackPrefill | null>(null);
  const [poll, setPoll] = useState(0);
  useEffect(() => {
    if (!isAdmin) return;
    const reload = () => setPoll((p) => p + 1);
    const id = setInterval(reload, FEEDBACK_POLL_MS);
    window.addEventListener(FEEDBACK_CHANGED, reload);
    return () => {
      clearInterval(id);
      window.removeEventListener(FEEDBACK_CHANGED, reload);
    };
  }, [isAdmin]);
  const fresh = newCount(useJson<Counts>(isAdmin ? "/api/feedback/counts" : null, poll).data);

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
                {item.to === "/feedback" && fresh > 0 && (
                  <span className="feedback-count" title={`${fresh} new`}>
                    {fresh}
                  </span>
                )}
              </NavLink>
            </li>
          ))}
        </ul>
        <div className="sidebar-user">
          <div className="sidebar-feedback">
            <button
              className="btn-sm"
              onClick={() => setFeedback(prefillFor(location.pathname, location.search))}
              title="Report a problem or suggest something"
            >
              Send feedback
            </button>
            {!isAdmin && (
              <NavLink to="/feedback" className="link-button">
                My feedback
              </NavLink>
            )}
          </div>
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
        <ErrorBoundary resetKey={location.pathname}>
          <Outlet />
        </ErrorBoundary>
      </main>
      {feedback && <FeedbackDialog prefill={feedback} onClose={() => setFeedback(null)} />}
    </div>
  );
}
