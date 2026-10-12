#!/usr/bin/env bash
# Build the FarmSlicer browser engine (libslic3r → WebAssembly).
#
#   wasm/build.sh            # both variants: st (single-threaded) + mt (pthreads)
#   wasm/build.sh st|mt      # one variant
#
# Environment:
#   WASM_DEPS_ENV   env.sh of a prepared toolchain (default: wasm/toolchain/env.sh;
#                   prepare with `bash wasm/toolchain/bootstrap.sh`, then
#                   `bash wasm/toolchain/build-deps.sh all` and
#                   `WASM_THREADS=1 bash wasm/toolchain/build-deps.sh all-mt`)
#   ORCA_SRC_DIR    OrcaSlicer tree to build (default: extern/OrcaSlicer). The
#                   libslic3r patch in wasm/patches/ is applied to it in place,
#                   idempotently. Use a separate copy if the same checkout also
#                   feeds the native build and you want it pristine.
#   NPROC           parallel compile jobs (default: 4; ~1-2 GB RAM each)
#   BUILD_VARIANT   release (default) | debug
#   OUT_DIR         where the engine files land (default: web/public/wasm)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

WASM_DEPS_ENV="${WASM_DEPS_ENV:-$ROOT/wasm/toolchain/env.sh}"
ORCA_SRC_DIR="${ORCA_SRC_DIR:-$ROOT/extern/OrcaSlicer}"
NPROC="${NPROC:-4}"
VARIANT="${BUILD_VARIANT:-release}"
OUT_DIR="${OUT_DIR:-$ROOT/web/public/wasm}"
PATCH="$ROOT/wasm/patches/orca-wasm.patch"

what="${1:-all}"
case "$what" in
  st) variants=(st) ;;
  mt) variants=(mt) ;;
  all) variants=(st mt) ;;
  *) echo "usage: $0 [st|mt|all]" >&2; exit 1 ;;
esac

[[ -f "$WASM_DEPS_ENV" ]] || { echo "toolchain env not found: $WASM_DEPS_ENV" >&2; exit 1; }
[[ -f "$ORCA_SRC_DIR/src/libslic3r/Print.hpp" ]] || { echo "not an OrcaSlicer tree: $ORCA_SRC_DIR" >&2; exit 1; }

# 1) libslic3r patch (idempotent). `git apply` needs a repo; a plain copy of
#    the tree gets `patch` instead.
if git -C "$ORCA_SRC_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if git -C "$ORCA_SRC_DIR" apply --reverse --check "$PATCH" 2>/dev/null; then
    echo "orca-wasm.patch already applied to $ORCA_SRC_DIR"
  else
    git -C "$ORCA_SRC_DIR" apply "$PATCH"
    echo "applied orca-wasm.patch to $ORCA_SRC_DIR"
  fi
else
  if patch -d "$ORCA_SRC_DIR" -p1 -R --dry-run -s < "$PATCH" >/dev/null 2>&1; then
    echo "orca-wasm.patch already applied to $ORCA_SRC_DIR"
  else
    patch -d "$ORCA_SRC_DIR" -p1 -s < "$PATCH"
    echo "applied orca-wasm.patch to $ORCA_SRC_DIR"
  fi
fi

orca_version="$(sed -n 's/^set(SoftFever_VERSION "\([^"]*\)").*/\1/p' "$ORCA_SRC_DIR/version.inc")"

# 2) Configure + build each variant in a subshell: env.sh reads WASM_THREADS
#    when sourced, and the two dependency prefixes must never mix.
for v in "${variants[@]}"; do
  (
    if [[ "$v" == mt ]]; then export WASM_THREADS=1; threads=ON; else export WASM_THREADS=0; threads=OFF; fi
    # shellcheck disable=SC1090
    source "$WASM_DEPS_ENV"
    build_dir="$ROOT/wasm/build-$v"
    [[ "$VARIANT" == debug ]] && build_dir="$build_dir-debug"
    echo "=== $v → $build_dir ==="
    emcmake cmake -S "$ROOT/wasm" -B "$build_dir" -G Ninja -DCMAKE_BUILD_TYPE=Release \
      -DBUILD_VARIANT="$VARIANT" -DORCA_WASM_THREADS="$threads" -DORCA_SRC_DIR="$ORCA_SRC_DIR"
    cmake --build "$build_dir" --target farmslicer_engine -j"$NPROC"

    name="farmslicer-engine"; [[ "$v" == mt ]] && name="farmslicer-engine-mt"
    mkdir -p "$OUT_DIR/$v"
    cp "$build_dir/$name.mjs" "$build_dir/$name.wasm" "$build_dir/$name.data" "$OUT_DIR/$v/"
    ls -la "$OUT_DIR/$v/"
  )
done

# 3) Manifest the frontend and the server read (which variants exist, sizes).
node - "$OUT_DIR" "$orca_version" <<'JS'
const fs = require("fs"), path = require("path");
const [out, orca] = process.argv.slice(2);
const variants = {};
for (const v of ["st", "mt"]) {
  const name = v === "mt" ? "farmslicer-engine-mt" : "farmslicer-engine";
  const dir = path.join(out, v);
  if (!fs.existsSync(path.join(dir, name + ".wasm"))) continue;
  variants[v] = {
    js: `${v}/${name}.mjs`, wasm: `${v}/${name}.wasm`, data: `${v}/${name}.data`,
    bytes: ["mjs", "wasm", "data"].reduce((n, e) => n + fs.statSync(path.join(dir, `${name}.${e}`)).size, 0),
  };
}
const manifest = { engine: "farmslicer", orca, variants, builtAt: new Date().toISOString() };
fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify(manifest, null, 2));
JS
