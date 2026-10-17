#!/usr/bin/env bash
# Build the server without libslic3r (FARMSLICER_SKIP_CXX: the stub slicer),
# then run each end-to-end test against its own fresh server on a throwaway
# data directory, listening on localhost only.
#
#   tests/run-e2e.sh                 # every tests/*-e2e.mjs
#   tests/run-e2e.sh tests/groups-e2e.mjs
#
# Needs cargo, node >= 22 and curl. PORT (default 9339) picks the port.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PORT="${PORT:-9339}"
export FARMSLICER_SKIP_CXX=1
cargo build --quiet
TARGET="${CARGO_TARGET_DIR:-$ROOT/target}"
BIN="$TARGET/debug/farmslicer"

tests=("$@")
if [ ${#tests[@]} -eq 0 ]; then
  tests=(tests/*-e2e.mjs)
fi

if curl -s -o /dev/null "http://localhost:$PORT/"; then
  echo "port $PORT is already in use; set PORT to a free one" >&2
  exit 2
fi

fail=0
for t in "${tests[@]}"; do
  run="$(mktemp -d)"
  # A test can ask for extra server environment with `// e2e-env: K=V ...`.
  # `{ROOT}` in a value stands for the repository root.
  read -r -a extra_env <<<"$(sed -n 's|^// e2e-env: ||p' "$t")"
  extra_env=("${extra_env[@]//\{ROOT\}/$ROOT}")
  (cd "$run" && exec env HOST=127.0.0.1 PORT="$PORT" FARMSLICER_ORIGINS="http://localhost:$PORT" "${extra_env[@]}" "$BIN") \
    >"$run/server.log" 2>&1 &
  pid=$!
  for _ in $(seq 1 100); do
    curl -sf "http://localhost:$PORT/api/health" >/dev/null && break
    sleep 0.1
  done
  if ! node "$t" "http://localhost:$PORT"; then
    fail=1
    echo "--- server log ($t) ---"
    tail -n 60 "$run/server.log"
  fi
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  rm -rf "$run"
done
exit "$fail"
