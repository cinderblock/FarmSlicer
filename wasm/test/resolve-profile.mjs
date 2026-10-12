#!/usr/bin/env node
// Resolve OrcaSlicer machine + process + filament profiles into the single
// merged config JSON the engine takes — the same thing the Rust server's
// ProfileStore::resolve_config does (follow `inherits`, child keys win, merge
// machine → process → filament, drop the profile-metadata keys). Lets the
// engine be smoke-tested without a running server.
//
//   node wasm/test/resolve-profile.mjs --profiles extern/OrcaSlicer/resources/profiles \
//        --machine "Bambu Lab A1 mini 0.4 nozzle" --process "0.20mm Standard @BBL A1M" \
//        --filament "Bambu PLA Basic @BBL A1M" > /tmp/config.json
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith("--")) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : "1"]);
    return acc;
  }, []),
);
const root = resolve(args.profiles ?? "extern/OrcaSlicer/resources/profiles");
for (const k of ["machine", "process", "filament"]) {
  if (!args[k]) {
    console.error(`--${k} is required`);
    process.exit(2);
  }
}

// Index every profile JSON by its "name", keeping the vendor: base profiles
// like fdm_process_common exist in ~60 vendor dirs with different contents,
// so a chain resolves its parents within the vendor it started in.
const byName = new Map(); // name → [{vendor, obj}]
function walk(dir, vendor) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, vendor ?? entry);
    else if (entry.endsWith(".json")) {
      try {
        const obj = JSON.parse(readFileSync(p, "utf8"));
        if (obj && typeof obj.name === "string") {
          if (!byName.has(obj.name)) byName.set(obj.name, []);
          byName.get(obj.name).push({ vendor: vendor ?? "", obj });
        }
      } catch {
        /* vendor index files etc. */
      }
    }
  }
}
walk(root, null);

function resolveChain(name) {
  const chain = [];
  const seen = new Set();
  let cur = name;
  let vendor = null;
  while (cur) {
    if (seen.has(cur)) throw new Error(`circular inheritance at ${cur}`);
    seen.add(cur);
    const candidates = byName.get(cur);
    if (!candidates) throw new Error(`profile '${cur}' not found under ${root}`);
    const hit = (vendor && candidates.find((c) => c.vendor === vendor)) || candidates[0];
    vendor ??= hit.vendor;
    const obj = hit.obj;
    chain.push(obj);
    cur = typeof obj.inherits === "string" && obj.inherits ? obj.inherits : null;
  }
  // Base first, child keys override.
  const merged = {};
  for (const obj of chain.reverse()) Object.assign(merged, obj);
  return merged;
}

const merged = {};
for (const k of ["machine", "process", "filament"]) Object.assign(merged, resolveChain(args[k]));
for (const k of [
  "type", "name", "inherits", "from", "instantiation", "setting_id",
  "compatible_printers", "compatible_printers_condition", "compatible_prints", "compatible_prints_condition",
]) delete merged[k];
process.stdout.write(JSON.stringify(merged) + "\n");
console.error(`${Object.keys(merged).length} keys from ${byName.size} indexed profiles`);
