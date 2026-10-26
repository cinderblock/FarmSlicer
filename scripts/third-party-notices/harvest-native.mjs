#!/usr/bin/env node
// Collects the licence texts of the C++ libraries, runtimes and data listed in
// native.json into native/<id>.txt, which third-party-notices.mjs then puts in
// THIRD-PARTY-NOTICES.txt. Run it after changing native.json; commit the
// result. It downloads the deps' source archives (checked against their
// SHA-256), so it is meant for a Linux box with curl, tar, unzip and docker
// (for {ubuntu} entries) — buildhost, say:
//
//   ORCA_DIR=extern/OrcaSlicer \                      # at the pinned tag
//   EMSDK_DIR=~/wasm-ref/wasm-deps/emsdk \            # wasm/toolchain's emsdk
//   NOTICES_CACHE=~/.cache/farmslicer-notices \       # downloads (kept)
//   node scripts/third-party-notices/harvest-native.mjs [id ...]
//
// With ids, only those components are harvested.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const expand = (p) => p.replace(/^~(?=\/|$)/, homedir());
const orcaDir = resolve(repo, expand(process.env.ORCA_DIR ?? "extern/OrcaSlicer"));
const emsdkDir = process.env.EMSDK_DIR ? resolve(expand(process.env.EMSDK_DIR)) : null;
const cache = resolve(expand(process.env.NOTICES_CACHE ?? join(homedir(), ".cache/farmslicer-notices")));
const outDir = join(here, "native");

// Top-level files that carry a licence or notice.
const LICENSE_NAME = /^(licen[cs]e|copying|copyright|notice|unlicense)([-._].*)?$/i;

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { maxBuffer: 256 * 1024 * 1024, ...opts }).toString("utf8");

/** The leading comment block of a source file (`/* ... *\/` or `//` lines). */
function leadingComment(text) {
  const t = text.replace(/^﻿/, "").replace(/^\s+/, "");
  if (t.startsWith("/*")) {
    const end = t.indexOf("*/");
    return t.slice(0, end < 0 ? undefined : end + 2);
  }
  // `//` lines, and the blank lines between them.
  const lines = [];
  for (const line of t.split(/\r?\n/)) {
    if (!/^\s*(\/\/.*)?$/.test(line)) break;
    lines.push(line);
  }
  return lines.join("\n").trim();
}

function excerpt(text, spec) {
  if (spec.header) return leadingComment(text);
  if (spec.lines) return text.split(/\r?\n/).slice(spec.lines[0] - 1, spec.lines[1]).join("\n");
  if (spec.tail) {
    const at = text.lastIndexOf(spec.tail);
    if (at < 0) throw new Error(`"${spec.tail}" not found`);
    return text.slice(text.lastIndexOf("\n", at) + 1);
  }
  return text;
}

function download(url, sha256) {
  mkdirSync(cache, { recursive: true });
  const file = join(cache, `${sha256.slice(0, 12)}-${basename(new URL(url).pathname)}`);
  if (!existsSync(file)) {
    console.error(`downloading ${url}`);
    run("curl", ["-fsSL", "--retry", "3", "--connect-timeout", "20", "-o", `${file}.partial`, url]);
    run("mv", [`${file}.partial`, file]);
  }
  const got = createHash("sha256").update(readFileSync(file)).digest("hex");
  if (got !== sha256.toLowerCase()) throw new Error(`${url}: sha256 ${got}, expected ${sha256}`);
  return file;
}

const isZip = (file) => file.endsWith(".zip");
const listArchive = (file) =>
  (isZip(file) ? run("unzip", ["-Z1", file]) : run("tar", ["-tf", file])).split("\n").filter(Boolean);
const readArchive = (file, entry) => (isZip(file) ? run("unzip", ["-p", file, entry]) : run("tar", ["-xOf", file, entry]));

/** Texts from an archive: its top-level licence files, or `files` (relative to the top dir; `dir/*` = every file in dir). */
function fromArchive(file, files) {
  const entries = listArchive(file).filter((e) => !e.endsWith("/"));
  const top = entries[0].split("/")[0];
  const rel = (e) => (e.startsWith(`${top}/`) ? e.slice(top.length + 1) : e);
  let picked;
  if (files) {
    picked = [];
    for (const want of files) {
      const hits = want.endsWith("/*")
        ? entries.filter((e) => dirname(rel(e)) === want.slice(0, -2))
        : entries.filter((e) => rel(e) === want);
      if (hits.length === 0) throw new Error(`${basename(file)}: no ${want}`);
      picked.push(...hits);
    }
  } else {
    picked = entries.filter((e) => !rel(e).includes("/") && LICENSE_NAME.test(rel(e)));
    if (picked.length === 0) throw new Error(`${basename(file)}: no top-level licence file`);
  }
  return picked.map((e) => ({ title: rel(e), text: readArchive(file, e) }));
}

function emport(name) {
  if (!emsdkDir) throw new Error("EMSDK_DIR not set");
  const dir = join(emsdkDir, "upstream/emscripten/cache/ports");
  const hit = readdirSync(dir).find((f) => f.startsWith(`${name}.`) && /\.(zip|tar\.gz|tgz)$/.test(f));
  if (!hit) throw new Error(`no cached Emscripten port ${name} in ${dir} (build the engine first)`);
  return join(dir, hit);
}

function harvest(spec) {
  if (spec.orca) return [{ title: spec.orca, text: excerpt(readFileSync(join(orcaDir, spec.orca), "utf8"), spec) }];
  if (spec.repo) return [{ title: spec.repo, text: excerpt(readFileSync(join(repo, spec.repo), "utf8"), spec) }];
  if (spec.emsdk) {
    if (!emsdkDir) throw new Error("EMSDK_DIR not set");
    const path = join(emsdkDir, "upstream/emscripten", spec.emsdk);
    return [{ title: `emscripten/${spec.emsdk}`, text: excerpt(readFileSync(path, "utf8"), spec) }];
  }
  if (spec.archive) return fromArchive(download(spec.archive, spec.sha256), spec.files);
  if (spec.emport) return fromArchive(emport(spec.emport), spec.files);
  if (spec.ubuntu) {
    const text = run("docker", ["run", "--rm", "ubuntu:24.04", "cat", `/usr/share/doc/${spec.ubuntu}/copyright`]);
    return [{ title: `ubuntu:24.04 /usr/share/doc/${spec.ubuntu}/copyright`, text }];
  }
  throw new Error(`unknown harvest spec ${JSON.stringify(spec)}`);
}

const { components } = JSON.parse(readFileSync(join(here, "native.json"), "utf8"));
const only = new Set(process.argv.slice(2));
mkdirSync(outDir, { recursive: true });
let failed = 0;
for (const c of components) {
  if (only.size && !only.has(c.id)) continue;
  if (!c.harvest?.length) continue;
  try {
    const parts = c.harvest.flatMap(harvest);
    const body = parts
      .map((p) => `--- ${p.title} ---\n\n${p.text.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trim()}\n`)
      .join("\n");
    writeFileSync(join(outDir, `${c.id}.txt`), body);
    console.error(`${c.id}: ${parts.map((p) => p.title).join(", ")}`);
  } catch (e) {
    failed++;
    console.error(`${c.id}: FAILED: ${e.message}`);
  }
}
process.exit(failed ? 1 : 0);
