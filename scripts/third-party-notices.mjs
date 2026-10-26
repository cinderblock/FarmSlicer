#!/usr/bin/env node
// Writes THIRD-PARTY-NOTICES.txt: the notices of everything FarmSlicer
// distributes that others wrote.
//
//   node scripts/third-party-notices.mjs            regenerate it
//   node scripts/third-party-notices.mjs --check    exit 1 if it is out of date
//   node scripts/third-party-notices.mjs --fetch-licenses
//                                                   also download missing standard
//                                                   licence texts (SPDX) into
//                                                   scripts/third-party-notices/licenses
//
// Sources:
// - Rust crates linked into the server: `cargo metadata` for the Linux target
//   (what the Docker image builds), normal dependencies reachable from
//   farmslicer, without proc-macro crates (they run at compile time only).
//   Needs cargo and the crates' sources (cargo metadata downloads them); no
//   build. Texts: each crate's own LICENSE/COPYING/NOTICE files.
// - JavaScript packages in the web app: the production dependency tree of
//   web/package.json in web/node_modules (run `bun install` in web/ first).
//   The Vite build checks that every package in the bundle is listed here.
// - C++ libraries, runtimes and data: scripts/third-party-notices/native.json
//   (hand-maintained) and the texts harvest-native.mjs collected from their
//   sources into scripts/third-party-notices/native/.
// Packages that ship no licence file get the standard text of their licence
// (scripts/third-party-notices/licenses/<SPDX id>.txt), which is also appended
// for every licence named anywhere.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = join(repo, "scripts/third-party-notices");
const licensesDir = join(dataDir, "licenses");
const outFile = join(repo, "THIRD-PARTY-NOTICES.txt");
const SPDX_DATA = "https://raw.githubusercontent.com/spdx/license-list-data/v3.29.0/text";
const TARGET = "x86_64-unknown-linux-gnu";

const args = new Set(process.argv.slice(2));
const check = args.has("--check");
const fetchLicenses = args.has("--fetch-licenses");

// Section titles; web/vite.config.ts finds the JavaScript list by its title.
const TITLE = {
  native: "C++ LIBRARIES, RUNTIMES AND DATA (server binary, browser engine, image)",
  rust: "RUST CRATES (linked into the server binary)",
  npm: "JAVASCRIPT PACKAGES (in the web app's bundle)",
  texts: "LICENCE AND NOTICE TEXTS",
  standard: "STANDARD LICENCE TEXTS",
};

const LICENSE_FILE = /^(licen[cs]e|copying|copyright|notice|unlicense)([-._].*)?$/i;
// Files a crate keeps below its root that hold the licence of what it bundles.
const EXTRA_FILES = { "openssl-src": ["openssl/LICENSE.txt"] };
// Licences whose text the recipient already has from FarmSlicer itself.
const OWN = new Set(["AGPL-3.0-only", "AGPL-3.0-or-later", "AGPL-3.0"]);
const NOT_SPDX = new Set(["various", "NOASSERTION"]);

const clean = (t) =>
  t.replace(/^﻿/, "").replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").replace(/^\n+|\s+$/g, "") + "\n";
const rule = (c) => c.repeat(80);

/** The licence ids in an SPDX expression (also Cargo's old "MIT/Apache-2.0"). */
function spdxIds(expr) {
  return (expr ?? "")
    .replace(/\//g, " OR ")
    .split(/[\s()]+/)
    .filter((t) => t && !/^(AND|OR|WITH)$/i.test(t) && !NOT_SPDX.has(t));
}

function licenseFiles(dir, extra = []) {
  const files = readdirSync(dir)
    .filter((f) => LICENSE_FILE.test(f) && statSync(join(dir, f)).isFile())
    .sort();
  return [...files, ...extra.filter((f) => existsSync(join(dir, f)))].map((f) => ({
    title: f,
    text: readFileSync(join(dir, f), "utf8"),
  }));
}

// ---- Rust -------------------------------------------------------------------

function rustCrates() {
  const meta = JSON.parse(
    execFileSync(
      process.env.CARGO ?? "cargo",
      ["metadata", "--format-version", "1", "--locked", "--filter-platform", TARGET],
      { cwd: repo, maxBuffer: 512 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] },
    ).toString(),
  );
  const pkgs = new Map(meta.packages.map((p) => [p.id, p]));
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
  const isProcMacro = (p) => p.targets.some((t) => t.kind.includes("proc-macro"));
  const seen = new Set();
  const stack = [meta.resolve.root];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dep of nodes.get(id).deps) {
      if (!dep.dep_kinds.some((k) => k.kind === null)) continue; // dev/build only
      if (isProcMacro(pkgs.get(dep.pkg))) continue;
      stack.push(dep.pkg);
    }
  }
  seen.delete(meta.resolve.root);
  return [...seen]
    .map((id) => pkgs.get(id))
    .map((p) => {
      const dir = dirname(p.manifest_path);
      const texts = licenseFiles(dir, EXTRA_FILES[p.name]);
      if (p.license_file && !texts.some((t) => t.title === basename(p.license_file))) {
        texts.push({ title: basename(p.license_file), text: readFileSync(join(dir, p.license_file), "utf8") });
      }
      return {
        name: p.name,
        version: p.version,
        license: p.license ?? "NOASSERTION",
        url: p.repository ?? p.homepage ?? `https://crates.io/crates/${p.name}`,
        authors: p.authors ?? [],
        texts,
      };
    });
}

// ---- npm ----------------------------------------------------------------------

function npmPackages() {
  const web = join(repo, "web");
  if (!existsSync(join(web, "node_modules"))) throw new Error("web/node_modules is missing: run `bun install` in web/");
  const resolvePkg = (fromDir, name) => {
    for (let d = fromDir; ; d = dirname(d)) {
      if (basename(d) !== "node_modules") {
        const hit = join(d, "node_modules", name);
        if (existsSync(join(hit, "package.json"))) return hit;
      }
      if (d === web || dirname(d) === d) return null;
    }
  };
  const root = JSON.parse(readFileSync(join(web, "package.json"), "utf8"));
  const found = new Map(); // dir -> package.json
  const visit = (fromDir, deps, optional) => {
    for (const name of Object.keys(deps ?? {})) {
      const dir = resolvePkg(fromDir, name);
      if (!dir) {
        if (optional) continue;
        throw new Error(`${name} (needed from ${fromDir}) is not installed: run \`bun install\` in web/`);
      }
      if (found.has(dir)) continue;
      const pj = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      found.set(dir, pj);
      visit(dir, pj.dependencies, false);
      visit(dir, pj.optionalDependencies, true);
    }
  };
  visit(web, root.dependencies, false);
  return [...found].map(([dir, pj]) => {
    let license = pj.license ?? pj.licenses ?? "NOASSERTION";
    if (typeof license === "object") license = [license].flat().map((l) => l.type ?? l).join(" OR ");
    const author = typeof pj.author === "string" ? pj.author : pj.author?.name;
    const repoUrl = typeof pj.repository === "string" ? pj.repository : pj.repository?.url;
    return {
      name: pj.name,
      version: pj.version,
      license,
      url: (pj.homepage ?? repoUrl ?? `https://www.npmjs.com/package/${pj.name}`).replace(/^git\+/, ""),
      authors: author ? [author] : [],
      texts: licenseFiles(dir),
    };
  });
}

// ---- native ---------------------------------------------------------------------

function nativeComponents() {
  const { components } = JSON.parse(readFileSync(join(dataDir, "native.json"), "utf8"));
  return components.map((c) => {
    const file = join(dataDir, "native", `${c.id}.txt`);
    const texts = existsSync(file) ? [{ title: `${c.id}`, text: readFileSync(file, "utf8") }] : [];
    if (c.harvest?.length && !texts.length) throw new Error(`native/${c.id}.txt missing: run harvest-native.mjs ${c.id}`);
    return { ...c, texts };
  });
}

// ---- standard texts ---------------------------------------------------------------

function standardText(id) {
  const file = join(licensesDir, `${id}.txt`);
  if (existsSync(file)) return readFileSync(file, "utf8");
  if (!fetchLicenses) throw new Error(`no standard text for ${id}: run with --fetch-licenses`);
  let out;
  try {
    out = execFileSync("curl", ["-fsSL", `${SPDX_DATA}/${id}.txt`], { stdio: ["ignore", "pipe", "ignore"] }).toString("utf8");
  } catch {
    throw new Error(`no SPDX text for "${id}" (${SPDX_DATA}/${id}.txt): not an SPDX id? Fix the licence in its source`);
  }
  mkdirSync(licensesDir, { recursive: true });
  writeFileSync(file, clean(out));
  return out;
}

// ---- output -----------------------------------------------------------------------

const texts = []; // { key, text, users: [] }
const byText = new Map();
function textRef(text, user) {
  const t = clean(text);
  const key = t.replace(/\s+/g, " "); // the same text, wrapped differently
  let entry = byText.get(key);
  if (!entry) {
    entry = { key: `[T${texts.length + 1}]`, text: t, users: [] };
    texts.push(entry);
    byText.set(key, entry);
  }
  if (!entry.users.includes(user)) entry.users.push(user);
  return entry.key;
}

// A licence file that is just the standard text (no copyright line or other
// addition of its own) is referred to section 5 instead of being repeated.
// Compared on letters and digits only (wrapping, quotes, http/https differ);
// Apache-2.0's unfilled appendix template may be present or not.
const letters = (t) => t.toLowerCase().replace(/https/g, "http").replace(/[^a-z0-9]/g, "");
const standardCache = new Map();
function standardOf(id) {
  if (!standardCache.has(id)) {
    const [terms, appendix = ""] = letters(standardText(id)).split("endoftermsandconditions");
    standardCache.set(id, { terms, appendix });
  }
  return standardCache.get(id);
}
/** null: not the standard text; "": exactly it; else the package's own
 *  addition after the terms (Apache-2.0's appendix filled in with a copyright). */
function standardRest(text, id) {
  const [terms, appendix = ""] = letters(text).split("endoftermsandconditions");
  const std = standardOf(id);
  if (terms !== std.terms) return null;
  if (appendix === "" || appendix === std.appendix || appendix.includes("yyyy")) return "";
  return text.slice(text.search(/END OF TERMS AND CONDITIONS/i));
}

const allIds = new Set();
function refsFor(item, label) {
  const itemIds = spdxIds(item.license);
  for (const id of itemIds) allIds.add(id);
  if (item.texts.length) {
    return item.texts.flatMap((t) => {
      if (t.title !== item.id) {
        for (const id of itemIds.filter((i) => !OWN.has(i))) {
          const rest = standardRest(t.text, id);
          if (rest === "") return [`[${id}]`];
          if (rest !== null) return [`[${id}]`, textRef(`--- ${t.title}, after the ${id} terms ---\n\n${rest}`, label)];
        }
      }
      return [textRef(`${t.title === item.id ? "" : `--- ${t.title} ---\n\n`}${t.text}`, label)];
    });
  }
  // Nothing shipped with the package: its authors and the standard texts.
  const ids = spdxIds(item.license).filter((id) => !OWN.has(id));
  const who = item.authors?.length ? `Copyright (c) ${item.authors.join(", ")}\n\n` : "";
  return ids.length ? [textRef(`${who}Licensed under ${item.license}; see the standard text${ids.length > 1 ? "s" : ""} of ${ids.join(", ")} at the end of this file.`, label)] : [];
}

function packageList(items, labelOf) {
  const lines = [];
  for (const it of items) {
    const label = labelOf(it);
    const refs = [...new Set(refsFor(it, label))];
    lines.push(`  ${label}`);
    lines.push(`      ${it.license}${refs.length ? `  ${refs.join(" ")}` : ""}`);
    lines.push(`      ${it.url}`);
  }
  return lines.join("\n");
}

const byName = (a, b) => a.name.localeCompare(b.name, "en") || a.version.localeCompare(b.version, "en");
const native = nativeComponents();
const rust = rustCrates().sort(byName);
const npm = npmPackages().sort(byName);

const out = [];
out.push(`FarmSlicer: third-party notices
${rule("=")}

FarmSlicer includes, links and sends to browsers software and data written by
others. This file lists them with their licences and reproduces the licence
and copyright notices they require. FarmSlicer's own licence is in LICENSE
(GNU AGPL v3) and NOTICE; the source code of every published build is at
https://github.com/cinderblock/FarmSlicer.

Generated by scripts/third-party-notices.mjs from Cargo.lock, web/package.json
and scripts/third-party-notices/native.json. References like [T3] point to
the texts in "${TITLE.texts}"; a reference like [MIT] means the package
ships that licence's standard text unchanged, which is in
"${TITLE.standard}" at the end with every other licence named here.

Contents
  1. ${TITLE.native}
  2. ${TITLE.rust}
  3. ${TITLE.npm}
  4. ${TITLE.texts}
  5. ${TITLE.standard}
`);

out.push(`\n${rule("=")}\n1. ${TITLE.native}\n${rule("=")}\n`);
out.push(`Where: server = linked into the server binary, wasm = compiled into the
browser engine (web app), image = a file in the Docker image, browser = data
sent to browsers.\n`);
for (const c of native) {
  const refs = refsFor(c, `${c.name}${c.version ? ` ${c.version}` : ""}`);
  out.push(`  ${c.name}${c.version ? ` ${c.version}` : ""}`);
  out.push(`      ${c.license}  (${c.in.join(", ")})${refs.length ? `  ${refs.join(" ")}` : ""}`);
  out.push(`      ${c.url}`);
  if (c.note) for (const line of wrap(c.note, 72)) out.push(`      ${line}`);
  out.push("");
}

out.push(`\n${rule("=")}\n2. ${TITLE.rust}\n${rule("=")}\n`);
out.push(`${rust.length} crates, for ${TARGET}.\n`);
out.push(packageList(rust, (p) => `${p.name} ${p.version}`));

out.push(`\n\n${rule("=")}\n3. ${TITLE.npm}\n${rule("=")}\n`);
out.push(`${npm.length} packages.\n`);
out.push(packageList(npm, (p) => `${p.name}@${p.version}`));

out.push(`\n\n${rule("=")}\n4. ${TITLE.texts}\n${rule("=")}\n`);
for (const t of texts) {
  out.push(`${rule("-")}\n${t.key} ${t.users.join(", ")}\n${rule("-")}\n`);
  out.push(t.text);
}

out.push(`\n${rule("=")}\n5. ${TITLE.standard}\n${rule("=")}\n`);
out.push(`The GNU AGPL v3 (AGPL-3.0-only, AGPL-3.0-or-later) is in LICENSE.\n`);
for (const id of [...allIds].filter((id) => !OWN.has(id)).sort()) {
  out.push(`${rule("-")}\n${id}\n${rule("-")}\n`);
  out.push(clean(standardText(id)));
}

const result = clean(out.join("\n"));

function wrap(text, width) {
  const lines = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

if (check) {
  const current = existsSync(outFile) ? clean(readFileSync(outFile, "utf8")) : "";
  if (current !== result) {
    console.error("THIRD-PARTY-NOTICES.txt is out of date: run node scripts/third-party-notices.mjs");
    process.exit(1);
  }
  console.error(`THIRD-PARTY-NOTICES.txt is up to date (${rust.length} crates, ${npm.length} npm packages, ${native.length} native components)`);
} else {
  writeFileSync(outFile, result);
  console.error(`wrote THIRD-PARTY-NOTICES.txt: ${rust.length} crates, ${npm.length} npm packages, ${native.length} native components, ${texts.length} texts, ${allIds.size} licences`);
}
