// The "Source code" link (src/source.ts): `bun test` in web/.
import { expect, test } from "bun:test";
import { sourceUrl } from "../src/source";

test("the server's template gets this build's commit", () => {
  expect(sourceUrl("https://github.com/cinderblock/FarmSlicer/tree/{commit}", "abc123")).toBe(
    "https://github.com/cinderblock/FarmSlicer/tree/abc123",
  );
  expect(sourceUrl("https://git.example.com/fork/-/tree/{commit}?ref={commit}", "abc")).toBe(
    "https://git.example.com/fork/-/tree/abc?ref=abc",
  );
});

test("a template without {commit} is used as it is", () => {
  expect(sourceUrl("https://example.com/our-source.tar.gz", "abc")).toBe("https://example.com/our-source.tar.gz");
});

test("no template (an older server) or no commit still links somewhere", () => {
  expect(sourceUrl(undefined, "abc")).toBe("https://github.com/cinderblock/FarmSlicer/tree/abc");
  expect(sourceUrl(null, "")).toBe("https://github.com/cinderblock/FarmSlicer/tree/master");
});
