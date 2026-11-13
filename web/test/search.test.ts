import { describe, expect, test } from "bun:test";
import { matchScore } from "../src/search";

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
