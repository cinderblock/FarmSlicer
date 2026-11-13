// The app's pages as the sidebar groups them; the command palette
// (components/CommandPalette.tsx) searches the same list.
import type { IconName } from "./components/Icon";

export type NavItem = { to: string; label: string; icon: IconName; keywords?: string };

/** The sidebar's sections; the command palette (Ctrl+K) lists the same. */
export const NAV_SECTIONS: { title: string; admin?: boolean; items: NavItem[] }[] = [
  {
    title: "Farm",
    items: [
      { to: "/", label: "Printers", icon: "printer", keywords: "home status farm cameras" },
      { to: "/queue", label: "Queue", icon: "queue", keywords: "waiting dispatch send next" },
      { to: "/prints", label: "Prints", icon: "prints", keywords: "history outcomes" },
    ],
  },
  {
    title: "Make",
    items: [
      { to: "/slice", label: "Slice", icon: "slice", keywords: "new model stl 3mf upload plate" },
      { to: "/jobs", label: "Jobs", icon: "jobs", keywords: "sliced gcode" },
      { to: "/projects", label: "Projects", icon: "projects", keywords: "orders parts demand" },
      { to: "/library", label: "Library", icon: "library", keywords: "season shared" },
    ],
  },
  {
    title: "Setup",
    items: [
      { to: "/profiles", label: "Profiles", icon: "profiles", keywords: "filament process machine presets" },
      { to: "/groups", label: "Groups", icon: "groups", keywords: "teams members quotas" },
      { to: "/guide", label: "Guide", icon: "guide", keywords: "help how to docs" },
    ],
  },
  {
    title: "Admin",
    admin: true,
    items: [
      { to: "/users", label: "Users", icon: "users", keywords: "accounts invites" },
      { to: "/feedback", label: "Feedback", icon: "feedback", keywords: "reports errors bugs" },
      { to: "/reports", label: "Reports", icon: "reports", keywords: "defaults statistics" },
      { to: "/integrations", label: "Integrations", icon: "integrations", keywords: "api keys webhooks" },
      { to: "/settings", label: "Settings", icon: "settings", keywords: "site prices rules limits" },
    ],
  },
];
