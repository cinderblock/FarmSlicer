import { describe, expect, test } from "bun:test";
import { decide, IDLE_RELOAD_MS, type Situation } from "../src/appUpdate";

/** Someone at the page, using it, an update waiting. */
const base: Situation = {
  pending: true,
  holds: 0,
  dialogOpen: false,
  dirty: false,
  hidden: false,
  idleMs: 1_000,
  navigated: false,
};

describe("decide", () => {
  test("nothing pending: never reloads", () => {
    expect(decide({ ...base, pending: false, navigated: true, hidden: true })).toBe("wait");
  });

  test("someone working on the page: waits (the banner offers it)", () => {
    expect(decide(base)).toBe("wait");
  });

  test("navigating loads the update", () => {
    expect(decide({ ...base, navigated: true })).toBe("reload");
  });

  test("navigating away from unsaved edits still loads it: the SPA dropped them anyway", () => {
    expect(decide({ ...base, navigated: true, dirty: true })).toBe("reload");
  });

  test("a hidden tab reloads", () => {
    expect(decide({ ...base, hidden: true })).toBe("reload");
  });

  test("an idle page reloads, a page just touched doesn't", () => {
    expect(decide({ ...base, idleMs: IDLE_RELOAD_MS })).toBe("reload");
    expect(decide({ ...base, idleMs: IDLE_RELOAD_MS - 1 })).toBe("wait");
  });

  test("unsaved edits keep a hidden or idle page", () => {
    expect(decide({ ...base, dirty: true, hidden: true })).toBe("wait");
    expect(decide({ ...base, dirty: true, idleMs: IDLE_RELOAD_MS * 10 })).toBe("wait");
  });

  test("a hold (a browser slice) keeps the page, even on navigation", () => {
    expect(decide({ ...base, holds: 1, hidden: true })).toBe("wait");
    expect(decide({ ...base, holds: 1, navigated: true })).toBe("wait");
  });

  test("an open dialog keeps the page", () => {
    expect(decide({ ...base, dialogOpen: true, hidden: true })).toBe("wait");
    expect(decide({ ...base, dialogOpen: true, navigated: true })).toBe("wait");
  });
});
