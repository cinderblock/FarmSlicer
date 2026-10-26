// Bambu code helpers (src/printers.ts): `bun test` in web/.
import { expect, test } from "bun:test";
import { hmsCode, hmsHelpUrl } from "../src/printers";

test("HMS codes as Bambu writes them, and their help link", () => {
  const h = { attr: 0x07002000, code: 0x00020001 };
  expect(hmsCode(h)).toBe("0700_2000_0002_0001");
  expect(hmsHelpUrl(h)).toBe("https://e.bambulab.com/index.php?e=0700200000020001&s=device_hms&lang=en");
  // Attrs above 0x7FFFFFFF arrive as negative numbers from some printers.
  expect(hmsHelpUrl({ attr: -1, code: 1 })).toBe("https://e.bambulab.com/index.php?e=FFFFFFFF00000001&s=device_hms&lang=en");
});
