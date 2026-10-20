// Harvests Bambu's printer message tables (HMS codes and print errors) into
// hms.json next to this file: `node src/bambu/data/harvest-hms.mjs`.
//
// The tables come from the host Bambu Studio and OrcaSlicer query
// (e.bambulab.com), one per device type (the first 3 characters of a
// printer's serial). Most texts are the same on every model, so each code
// keeps its most common text and only the device types that differ get their
// own.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Device types that answer with a table (an unknown one answers result 201).
const DEVICES = ["00M", "00W", "01S", "01P", "030", "039", "03W", "093", "094", "22E", "239", "31B"];
const LANG = "en";

const tables = { hms: new Map(), errors: new Map() };
let version = 0;
for (const device of DEVICES) {
  const res = await fetch(`https://e.bambulab.com/query.php?lang=${LANG}&d=${device}`);
  if (!res.ok) throw new Error(`${device}: HTTP ${res.status}`);
  const body = await res.json();
  if (body.result !== 0) throw new Error(`${device}: result ${body.result}`);
  version = Math.max(version, Number(body.ver));
  for (const [kind, key] of [["hms", "device_hms"], ["errors", "device_error"]]) {
    for (const { ecode, intro } of body.data[key][LANG]) {
      const code = ecode.toUpperCase();
      if (!tables[kind].has(code)) tables[kind].set(code, new Map());
      // An empty text is a code Bambu's apps don't show.
      if (intro.trim()) tables[kind].get(code).set(device, intro.trim());
    }
  }
}

const out = { source: "e.bambulab.com", version, lang: LANG, hms: {}, errors: {}, by_device: {} };
for (const kind of ["hms", "errors"]) {
  for (const code of [...tables[kind].keys()].sort()) {
    const texts = tables[kind].get(code);
    if (texts.size === 0) continue;
    const counts = new Map();
    for (const t of texts.values()) counts.set(t, (counts.get(t) ?? 0) + 1);
    const common = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
    out[kind][code] = common;
    for (const [device, text] of texts) {
      if (text === common) continue;
      out.by_device[device] ??= { hms: {}, errors: {} };
      out.by_device[device][kind][code] = text;
    }
  }
}
const sorted = Object.fromEntries(Object.keys(out.by_device).sort().map((d) => [d, out.by_device[d]]));
out.by_device = sorted;

const path = fileURLToPath(new URL("./hms.json", import.meta.url));
writeFileSync(path, JSON.stringify(out, null, 1) + "\n");
console.log(
  `${path}: ${Object.keys(out.hms).length} HMS codes, ${Object.keys(out.errors).length} errors, version ${version}`,
);
