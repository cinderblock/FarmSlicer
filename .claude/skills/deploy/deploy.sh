#!/usr/bin/env bash
set -euo pipefail

# Prevent MSYS/Git Bash from mangling Unix paths into Windows paths
export MSYS_NO_PATHCONV=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load .env
if [[ -f "$SCRIPT_DIR/.env" ]]; then
    set -a
    source "$SCRIPT_DIR/.env"
    set +a
else
    echo "Error: $SCRIPT_DIR/.env not found. Copy .env.example and fill it in." >&2
    exit 1
fi

: "${DEPLOY_USER:?DEPLOY_USER not set in .env}"
: "${DEPLOY_HOST:?DEPLOY_HOST not set in .env}"

REPO_URL="${REPO_URL:-git@github.com:cinderblock/FarmSlicer.git}"
REMOTE_DIR="${REMOTE_DIR:-/opt/farmslicer}"
SERVICE_NAME="${SERVICE_NAME:-farmslicer}"
SERVICE_PORT="${SERVICE_PORT:-9337}"
ADMIN_PASSPHRASE="${ADMIN_PASSPHRASE:-}"
BUILD_JOBS="${BUILD_JOBS:-}"

SSH_TARGET="$DEPLOY_USER@$DEPLOY_HOST"

# ── Helpers ──────────────────────────────────────────────────────────────────

ssh_run() {
    ssh -A -o ConnectTimeout=10 "$SSH_TARGET" -- "$@"
}

ssh_tty() {
    ssh -A -t -o ConnectTimeout=10 "$SSH_TARGET" -- "$@"
}

jobs_flag() {
    if [[ -n "$BUILD_JOBS" ]]; then
        echo "-j$BUILD_JOBS"
    else
        echo "-j\$(nproc)"
    fi
}

usage() {
    cat <<'EOF'
Usage: deploy.sh <command> [args...]

Remote management for FarmSlicer on a Linux server via SSH.

Commands:
  status             Show systemd service status
  start              Start the service
  stop               Stop the service
  restart            Restart the service
  logs [-f]          View service logs (-f to follow)

  setup-tools        Install build prerequisites (apt, rustup, nvm)
  clone              Clone the repo on the remote (first-time setup)
  pull               Pull latest code and update submodules
  setup-deps         Build OrcaSlicer C++ dependencies (slow, one-time)
  build              Build FarmSlicer (cargo build --release)
  setup-service      Install/update the systemd unit file

  deploy             Pull + build + restart (full redeploy)
  ssh                Open an interactive shell on the remote

  help               Show this message
EOF
}

# ── Commands ─────────────────────────────────────────────────────────────────

cmd_status() {
    ssh_run systemctl status "$SERVICE_NAME" || true
}

cmd_start() {
    ssh_run sudo systemctl start "$SERVICE_NAME"
    echo "Started $SERVICE_NAME"
}

cmd_stop() {
    ssh_run sudo systemctl stop "$SERVICE_NAME"
    echo "Stopped $SERVICE_NAME"
}

cmd_restart() {
    ssh_run sudo systemctl restart "$SERVICE_NAME"
    echo "Restarted $SERVICE_NAME"
}

cmd_logs() {
    local follow=""
    if [[ "${1:-}" == "-f" ]]; then
        follow="-f"
    fi
    # Use ssh -t so ctrl-c works for follow mode
    ssh_tty journalctl -u "$SERVICE_NAME" --no-pager -n 100 $follow
}

cmd_setup_tools() {
    echo "==> Installing build prerequisites on $DEPLOY_HOST..."
    ssh_run bash -s <<'REMOTE_SCRIPT'
set -euo pipefail

echo "--- apt packages ---"
sudo apt-get update -qq
sudo apt-get install -y -qq \
    build-essential cmake perl libssl-dev libgtk-3-dev libglu1-mesa-dev \
    libfontconfig1-dev libdbus-1-dev pkg-config m4 git curl \
    texinfo autoconf automake libtool

echo "--- rustup ---"
if command -v rustup &>/dev/null; then
    echo "rustup already installed, updating..."
    rustup update
else
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    echo 'source "$HOME/.cargo/env"' >> ~/.bashrc
fi
source "$HOME/.cargo/env" 2>/dev/null || true

echo "--- node (via nvm) ---"
if command -v node &>/dev/null; then
    echo "node $(node --version) already installed"
else
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"
    nvm install --lts
fi

echo "=== All build tools ready ==="
REMOTE_SCRIPT
    echo "Done."
}

cmd_clone() {
    echo "==> Cloning $REPO_URL into $REMOTE_DIR on $DEPLOY_HOST..."
    ssh_run bash -s -- "$REPO_URL" "$REMOTE_DIR" <<'REMOTE_SCRIPT'
set -euo pipefail
REPO_URL="$1"
REMOTE_DIR="$2"

if [[ -d "$REMOTE_DIR/.git" ]]; then
    echo "Repo already exists at $REMOTE_DIR"
    exit 0
fi

sudo mkdir -p "$(dirname "$REMOTE_DIR")"
sudo chown "$USER:$USER" "$(dirname "$REMOTE_DIR")"
git clone --recurse-submodules "$REPO_URL" "$REMOTE_DIR"
echo "Cloned to $REMOTE_DIR"
REMOTE_SCRIPT
    echo "Done."
}

cmd_pull() {
    echo "==> Pulling latest on $DEPLOY_HOST..."
    ssh_run bash -s -- "$REMOTE_DIR" <<'REMOTE_SCRIPT'
set -euo pipefail
cd "$1"
git pull --ff-only
git submodule update --init --recursive
REMOTE_SCRIPT
    echo "Done."
}

cmd_setup_deps() {
    echo "==> Building OrcaSlicer dependencies on $DEPLOY_HOST (this takes a while)..."
    ssh_run bash -s -- "$REMOTE_DIR" "${BUILD_JOBS:-0}" <<'REMOTE_SCRIPT'
set -euo pipefail
REMOTE_DIR="$1"
JOBS="$2"
if [[ "$JOBS" == "0" ]]; then JOBS="$(nproc)"; fi

cd "$REMOTE_DIR/extern/OrcaSlicer/deps"
mkdir -p build && cd build
cmake .. -DCMAKE_BUILD_TYPE=Release
# Build all deps needed for headless (non-GUI) libslic3r
make -j"$JOBS" \
    dep_Boost dep_TBB dep_CURL dep_OCCT dep_OpenVDB \
    dep_Eigen dep_GMP dep_MPFR dep_NLopt dep_CGAL dep_Cereal \
    dep_Draco dep_Blosc dep_OpenEXR dep_JPEG dep_PNG dep_FREETYPE \
    dep_OpenCV dep_OpenSSL dep_Qhull dep_libnoise dep_GLFW dep_GLEW

echo "--- Building libslic3r ---"
cd "$REMOTE_DIR/extern/OrcaSlicer"
mkdir -p build && cd build
cmake .. -DCMAKE_BUILD_TYPE=Release -DSLIC3R_GUI=OFF
make -j"$JOBS" libslic3r libslic3r_cgal libnest2d

echo "=== OrcaSlicer deps built ==="
REMOTE_SCRIPT
    echo "Done."
}

cmd_build() {
    echo "==> Building FarmSlicer on $DEPLOY_HOST..."
    ssh_run bash -s -- "$REMOTE_DIR" <<'REMOTE_SCRIPT'
set -euo pipefail
source "$HOME/.cargo/env" 2>/dev/null || true
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh" 2>/dev/null || true

cd "$1"

echo "--- frontend ---"
cd web && npm install && npx vite build && cd ..

echo "--- cargo build --release ---"
cargo build --release

echo "=== Build complete ==="
ls -lh target/release/farmslicer
REMOTE_SCRIPT
    echo "Done."
}

cmd_setup_service() {
    echo "==> Installing systemd service on $DEPLOY_HOST..."
    ssh_run bash -s -- "$SERVICE_NAME" "$REMOTE_DIR" "$DEPLOY_USER" "$SERVICE_PORT" "$ADMIN_PASSPHRASE" <<'REMOTE_SCRIPT'
set -euo pipefail
SERVICE_NAME="$1"
REMOTE_DIR="$2"
SERVICE_USER="$3"
SERVICE_PORT="$4"
ADMIN_PASSPHRASE="${5:-}"

UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

PASSPHRASE_LINE=""
if [[ -n "$ADMIN_PASSPHRASE" ]]; then
    PASSPHRASE_LINE="Environment=ADMIN_PASSPHRASE=$ADMIN_PASSPHRASE"
fi

sudo tee "$UNIT_FILE" > /dev/null <<UNIT
[Unit]
Description=FarmSlicer — headless slicing service
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$REMOTE_DIR
ExecStart=$REMOTE_DIR/target/release/farmslicer
Restart=on-failure
RestartSec=5
Environment=RUST_LOG=info
Environment=PORT=$SERVICE_PORT
$PASSPHRASE_LINE

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
echo "Service $SERVICE_NAME installed and enabled"
echo "Unit file: $UNIT_FILE"
REMOTE_SCRIPT
    echo "Done."
}

cmd_deploy() {
    cmd_pull
    cmd_build
    cmd_restart
    echo "==> Deploy complete. Service running on port $SERVICE_PORT."
}

cmd_ssh() {
    exec ssh "$SSH_TARGET" -t "cd $REMOTE_DIR 2>/dev/null; exec \$SHELL -l"
}

# ── Dispatch ─────────────────────────────────────────────────────────────────

case "${1:-help}" in
    status)        cmd_status ;;
    start)         cmd_start ;;
    stop)          cmd_stop ;;
    restart)       cmd_restart ;;
    logs)          shift; cmd_logs "$@" ;;
    setup-tools)   cmd_setup_tools ;;
    clone)         cmd_clone ;;
    pull)          cmd_pull ;;
    setup-deps)    cmd_setup_deps ;;
    build)         cmd_build ;;
    setup-service) cmd_setup_service ;;
    deploy)        cmd_deploy ;;
    ssh)           cmd_ssh ;;
    help|--help|-h) usage ;;
    *)
        echo "Unknown command: $1" >&2
        usage >&2
        exit 1
        ;;
esac
