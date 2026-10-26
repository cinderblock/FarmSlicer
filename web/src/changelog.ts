// What's new, for the people using FarmSlicer (components/WhatsNewDialog.tsx).
//
// Newest first. One entry per release that changes something people see:
// the few changes worth knowing about as `highlights`, and small fixes
// summed up in one `fixes` line, never listed one by one. Written for
// users, not developers: what they can do now, not how it was built.
// `id` is the release date (YYYY-MM-DD); a second release on one day adds
// a suffix ("2026-10-24b"). web/test/whatsNew.test.ts checks the shape.
// (Not in src/data: the server build copies that directory.)

export interface ChangelogEntry {
  /** Unique, and sorts with the date: YYYY-MM-DD plus an optional letter. */
  id: string;
  /** The release date, YYYY-MM-DD (local time). */
  date: string;
  title: string;
  highlights: string[];
  /** The small fixes, summed up in a sentence. */
  fixes?: string;
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    id: "2026-10-26",
    date: "2026-10-26",
    title: "FarmSlicer as an app",
    highlights: [
      "FarmSlicer can be installed as an app: “Install app” at the bottom of the menu puts it on your phone's home screen or your computer's app list, where it opens in its own window.",
    ],
  },
  {
    id: "2026-10-25",
    date: "2026-10-25",
    title: "Camera fixes",
    highlights: [],
    fixes: "A printer's camera picks up again after you switch away from the browser on a phone, and closing it no longer shows an error page.",
  },
  {
    id: "2026-10-24",
    date: "2026-10-24",
    title: "Recent slices, and updates that don't get in your way",
    highlights: [
      "The Slice page remembers your recent slices: slicing the same thing again shows the earlier result at once, and the Preview tab compares two slices, overlaid or side by side.",
      "This “What's new” window: it opens when something has changed, and “What's new” at the bottom of the menu shows it again.",
      "A new version no longer reloads the page while you work. It waits until you go to another page or step away, and a banner lets you load it sooner.",
      "The Slice page keeps your plate and settings when the page reloads, by hand or for an update.",
    ],
  },
  {
    id: "2026-10-23",
    date: "2026-10-23",
    title: "Filament mapping",
    highlights: [],
    fixes: "Bambu printers with an AMS take a print's filament from the AMS before an external spool.",
  },
  {
    id: "2026-10-20",
    date: "2026-10-20",
    title: "Projects and the print queue",
    highlights: [
      "Several plates per job: a job's parts can be spread over as many plates as they need.",
      "Projects: say how many of each part you need, and see how many have printed.",
      "The print queue: plates wait there for a printer, and “Send next” picks the next one that fits.",
      "After a print, record how it came out: good copies, failed ones and why.",
      "Printer pools and operators: people who run a set of printers can work the queue and control them.",
      "Hands-off printing: a printer can take the next plate from the queue by itself once its bed has been cleared (on printers that tell us the door was opened and closed).",
      "Plates are made automatically for parts a project still needs.",
      "Printer errors from Bambu printers now say what they mean.",
    ],
    fixes: "The G-code check reads the templates of Bambu Studio 2.5 and later.",
  },
  {
    id: "2026-10-16",
    date: "2026-10-16",
    title: "A fuller slicer",
    highlights: [
      "Several parts on one plate: add more models, duplicate a part, fill the plate, or arrange everything.",
      "A Supports section, on by default, with support materials and a check for overhangs that need support.",
      "A layer-by-layer preview of the G-code, on the Slice page after slicing and on each job's page.",
      "Jobs keep their models and settings: “Re-slice” opens a job again to change it, and jobs can be deleted.",
      "Dual-nozzle printers (H2D): each filament goes on a nozzle that has it loaded.",
      "“Send feedback” in the menu, to report a problem or suggest something. Errors in the app are reported automatically.",
      "Works on phones: a menu button instead of the sidebar, and lists as cards.",
    ],
    fixes: "Layout fixes on narrow windows and touch screens.",
  },
  {
    id: "2026-10-15",
    date: "2026-10-15",
    title: "Placing parts, and access from outside",
    highlights: [
      "Move, rotate and lay parts flat on the plate with handles, as in Bambu Studio; the slicer prints them where you put them.",
      "Accounts an admin approves can sign in from outside the local network, with a passkey.",
    ],
  },
  {
    id: "2026-10-13",
    date: "2026-10-13",
    title: "Printers of every make",
    highlights: [
      "Klipper (Moonraker), OctoPrint, Prusa (PrusaLink) and Elegoo Centauri Carbon printers, next to Bambu: status, sending, controls and cameras.",
      "Printers on the network are found automatically.",
      "Plain G-code from any slicer can be uploaded and sent.",
      "Every file is checked before it reaches a printer, and custom G-code that fails the check is held for review.",
    ],
  },
  {
    id: "2026-10-12",
    date: "2026-10-12",
    title: "Accounts, groups and printing",
    highlights: [
      "Sign in with a passkey: no passwords.",
      "Groups with shared libraries and print quotas; join links and guest accounts.",
      "Live printer status, sending jobs to printers, and following prints.",
      "Printer cameras, and pictures of what each printer is printing.",
      "Print rules with approvals, problem reports, pre-heating, and filament cost estimates.",
      "A Guide page explaining how printing works here.",
    ],
  },
  {
    id: "2026-10-11",
    date: "2026-10-11",
    title: "FarmSlicer is online",
    highlights: ["Slice on the server or right in your browser, with OrcaSlicer's printer profiles."],
  },
];
