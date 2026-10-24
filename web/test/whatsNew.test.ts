import { describe, expect, test } from "bun:test";
import { CHANGELOG, type ChangelogEntry } from "../src/changelog";
import { localDay, unseenEntries } from "../src/whatsNew";

const entry = (id: string): ChangelogEntry => ({ id, date: id.slice(0, 10), title: id, highlights: ["x"] });
const log = [entry("2026-10-24"), entry("2026-10-20b"), entry("2026-10-20"), entry("2026-10-12")];
const ids = (list: ChangelogEntry[]) => list.map((e) => e.id);

describe("unseenEntries", () => {
  test("only what is newer than the last seen", () => {
    expect(ids(unseenEntries(log, "2026-10-20", null))).toEqual(["2026-10-24", "2026-10-20b"]);
  });

  test("nothing new once the newest was seen", () => {
    expect(unseenEntries(log, "2026-10-24", null)).toEqual([]);
  });

  test("a browser that has seen nothing gets only the newest", () => {
    expect(ids(unseenEntries(log, null, null))).toEqual(["2026-10-24"]);
  });

  test("releases from before the account was made are left out", () => {
    expect(ids(unseenEntries(log, "2026-10-01", "2026-10-20"))).toEqual(["2026-10-24", "2026-10-20b", "2026-10-20"]);
    expect(unseenEntries(log, null, "2026-10-25")).toEqual([]);
  });
});

describe("localDay", () => {
  test("a SQLite UTC time is read as UTC", () => {
    const day = localDay("2026-10-20 12:00:00");
    // Noon UTC is the same calendar day from UTC-12 to UTC+11.
    expect(day).toBe("2026-10-20");
  });

  test("nothing or junk is null", () => {
    expect(localDay(null)).toBeNull();
    expect(localDay("yesterday")).toBeNull();
  });
});

describe("the changelog", () => {
  test("has entries", () => {
    expect(CHANGELOG.length).toBeGreaterThan(0);
  });

  test("ids are unique, newest first, and start with their date", () => {
    expect(new Set(ids(CHANGELOG)).size).toBe(CHANGELOG.length);
    expect(ids(CHANGELOG)).toEqual(ids(CHANGELOG).toSorted().reverse());
    for (const e of CHANGELOG) {
      expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.id).toMatch(/^\d{4}-\d{2}-\d{2}[a-z]?$/);
      expect(e.id.startsWith(e.date)).toBe(true);
    }
  });

  test("every entry says something", () => {
    for (const e of CHANGELOG) {
      expect(e.title.trim()).not.toBe("");
      expect(e.highlights.length > 0 || !!e.fixes).toBe(true);
    }
  });
});
