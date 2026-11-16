import { describe, expect, test } from "bun:test";
import { pageTitle } from "../src/nav";
import { completeLabel, labelsMatching, matchScore, parseQuery } from "../src/search";

describe("matchScore", () => {
  test("no words matches everything", () => {
    expect(matchScore([], "Printers")).toBe(1);
  });

  test("every word must match somewhere", () => {
    expect(matchScore(["vor", "zzz"], "Voron A")).toBe(0);
    expect(matchScore(["vor", "a"], "Voron A")).toBeGreaterThan(0);
  });

  test("a prefix of the name beats a word inside it, which beats a substring, which beats keywords", () => {
    const prefix = matchScore(["pri"], "Prints");
    const word = matchScore(["pri"], "Bench Prusa printer");
    const inside = matchScore(["rin"], "Prints");
    const keyword = matchScore(["gcode"], "Jobs", "sliced gcode");
    expect(prefix).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(inside);
    expect(inside).toBeGreaterThan(keyword);
    expect(keyword).toBeGreaterThan(0);
  });

  test("matching ignores case in the name and keywords (words come lower-cased)", () => {
    expect(matchScore(["x1c"], "X1C Lab")).toBeGreaterThan(0);
    expect(matchScore(["stl"], "Slice", "New Model STL")).toBeGreaterThan(0);
  });
});

describe("parseQuery", () => {
  test("plain words, lower-cased", () => {
    expect(parseQuery("Voron  A")).toEqual({ words: ["voron", "a"], labels: [], typingLabel: null });
  });

  test("label: filters, bare or quoted, among the words", () => {
    expect(parseQuery('label:Urgent bench label:"Needs review" x')).toEqual({
      words: ["bench", "x"],
      labels: ["urgent", "needs review"],
      typingLabel: null,
    });
  });

  test("a label: token at the end is still being typed, and filters as far as it goes", () => {
    expect(parseQuery("bench label:")).toEqual({ words: ["bench"], labels: [], typingLabel: "" });
    expect(parseQuery("label:urg")).toEqual({ words: [], labels: ["urg"], typingLabel: "urg" });
    expect(parseQuery('label:"needs re')).toEqual({ words: [], labels: ["needs re"], typingLabel: "needs re" });
    expect(parseQuery('label:"')).toEqual({ words: [], labels: [], typingLabel: "" });
    // Closed, or followed by a space: done.
    expect(parseQuery('label:"needs review"').typingLabel).toBeNull();
    expect(parseQuery("label:urgent ").typingLabel).toBeNull();
  });
});

describe("labelsMatching", () => {
  const labels = [
    { id: "1", name: "Urgent" },
    { id: "2", name: "Urgent later" },
    { id: "3", name: "Needs review" },
  ];
  test("an exact name wins over names starting with it", () => {
    expect(labelsMatching("urgent", labels).map((l) => l.id)).toEqual(["1"]);
  });
  test("else names starting with it, else a word starting with it", () => {
    expect(labelsMatching("urg", labels).map((l) => l.id)).toEqual(["1", "2"]);
    expect(labelsMatching("rev", labels).map((l) => l.id)).toEqual(["3"]);
    expect(labelsMatching("zzz", labels)).toEqual([]);
  });
});

describe("completeLabel", () => {
  test("replaces the label: token being typed, quoting names with spaces", () => {
    expect(completeLabel("bench label:urg", "Urgent")).toBe("bench label:Urgent ");
    expect(completeLabel('label:"nee', "Needs review")).toBe('label:"Needs review" ');
    expect(completeLabel("x label:a label:", "Urgent")).toBe("x label:a label:Urgent ");
  });
});

describe("pageTitle", () => {
  test("names the page, then the app", () => {
    expect(pageTitle("/")).toBe("Printers · FarmSlicer");
    expect(pageTitle("/jobs")).toBe("Jobs · FarmSlicer");
    expect(pageTitle("/jobs/abc")).toBe("Jobs · FarmSlicer");
    expect(pageTitle("/account")).toBe("Account · FarmSlicer");
    expect(pageTitle("/nowhere")).toBe("FarmSlicer");
  });
});
