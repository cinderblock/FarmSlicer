import { expect, test } from "bun:test";
import { parseWarnings, sortWarnings } from "./slicerWarnings";

test("support warnings first, technical notes apart even when they mention floating", () => {
  const ignored = "ignored 62 config keys unknown to libslic3r: detect_floating_vertical_shell internal_bridge_support_thickness";
  const support = "It seems object tee.stl has floating cantilever. Please re-orient the object or enable support generation.";
  const other = "Detected print stability issues";
  expect(sortWarnings([ignored, support, other])).toEqual({ support: [support], other: [other], technical: [ignored] });
});

test("unreadable warning lists are empty", () => {
  expect(parseWarnings(null)).toEqual([]);
  expect(parseWarnings("{nope")).toEqual([]);
  expect(parseWarnings('["a", 2]')).toEqual(["a", "2"]);
});
