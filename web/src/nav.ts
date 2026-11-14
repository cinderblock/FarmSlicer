// The app's pages as the sidebar groups them; the command palette
// (components/CommandPalette.tsx) searches the same list.
import type { SiteCap } from "./auth";
import type { IconName } from "./components/Icon";

/** `cap`: shown only to holders of one of these site capabilities. */
export type NavItem = { to: string; label: string; icon: IconName; keywords?: string; cap?: SiteCap[] };
export type NavSection = { title: string; items: NavItem[] };

/** The sidebar's sections; the command palette (Ctrl+K) lists the same. */
export const NAV_SECTIONS: NavSection[] = [
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
    items: [
      { to: "/users", label: "Users", icon: "users", keywords: "accounts invites suspend", cap: ["users.view"] },
      {
        to: "/roles",
        label: "Roles",
        icon: "shield",
        keywords: "permissions capabilities access",
        cap: ["roles.manage", "users.manage"],
      },
      { to: "/audit", label: "Audit log", icon: "history", keywords: "changes who history", cap: ["audit.view"] },
      { to: "/feedback", label: "Feedback", icon: "feedback", keywords: "reports errors bugs", cap: ["feedback.triage"] },
      { to: "/reports", label: "Reports", icon: "reports", keywords: "defaults statistics", cap: ["reports.view"] },
      {
        to: "/integrations",
        label: "Integrations",
        icon: "integrations",
        keywords: "api keys webhooks",
        cap: ["integrations.manage"],
      },
      { to: "/settings", label: "Settings", icon: "settings", keywords: "site prices rules limits", cap: ["settings.manage"] },
    ],
  },
];

/** The sections and pages this account may open (empty sections dropped). */
export function visibleSections(can: (cap: SiteCap) => boolean): NavSection[] {
  return NAV_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter((item) => !item.cap || item.cap.some(can)),
  })).filter((section) => section.items.length > 0);
}

const EXTRA_TITLES: [string, string][] = [
  ["/account", "Account"],
  ["/join", "Join"],
];

/** The browser tab's title for a path: its page's name, then the app's. */
export function pageTitle(pathname: string): string {
  const items = NAV_SECTIONS.flatMap((section) => section.items);
  const match =
    items.find((item) => item.to === pathname) ??
    items.find((item) => item.to !== "/" && pathname.startsWith(`${item.to}/`));
  const name = match?.label ?? EXTRA_TITLES.find(([prefix]) => pathname.startsWith(prefix))?.[1];
  return name ? `${name} · FarmSlicer` : "FarmSlicer";
}
