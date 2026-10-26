# syntax=docker/dockerfile:1.7
#
# FarmSlicer image. Four build stages, one runtime stage:
#
#   orca-deps  OrcaSlicer's third-party C++ deps (Boost, TBB, OCCT, OpenVDB,
#              CGAL, ...). Slow (~1 h on a GitHub runner). Keyed on
#              extern/OrcaSlicer/deps only, so it is rebuilt only when the
#              submodule's dependency recipe changes.
#   libslic3r  the slicing library itself, headless (SLIC3R_GUI=OFF).
#   web        the React frontend (Vite) → dist/web.
#   server     the Rust server, linking libslic3r through the cxx bridge.
#   runtime    ubuntu + the binary + static assets + OrcaSlicer profiles.
#
# Build:   docker build -t farmslicer .
# Run:     docker run -p 9337:9337 -v farmslicer_data:/app/data farmslicer
#
# What runs on buildhost is decided in OWNER/ops (servers/buildhost/stacks/
# farmslicer/pin.json); this file only produces the candidate image.

ARG UBUNTU_VERSION=24.04

# ---------------------------------------------------------------------------
FROM ubuntu:${UBUNTU_VERSION} AS cxx-base
ENV DEBIAN_FRONTEND=noninteractive
# libfontconfig1-dev is required by libslic3r (text shapes) and pulls in the
# zlib/png/freetype/expat dev packages, which the deps superbuild then uses
# from the system instead of building. The runtime stage installs the matching
# shared libraries via libfontconfig1.
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential cmake ninja-build perl git curl ca-certificates \
        m4 texinfo autoconf automake libtool pkg-config \
        libglu1-mesa-dev libfontconfig1-dev \
    && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
FROM cxx-base AS orca-deps
# JOBS: parallel compile jobs (default: all cores). Set lower on a shared box.
ARG JOBS
WORKDIR /orca
COPY extern/OrcaSlicer/deps deps
# Headless subset of OrcaSlicer's dependency superbuild: every dep_* target the
# configure step generated (it omits whatever it found on the system) minus the
# ones only the wxWidgets GUI needs. OpenSSL (1.1.1) and curl are left out too:
# headless libslic3r uses no curl, and from OpenSSL only MD5, which a standalone
# header gives it (cxx/shims, see the libslic3r stage). CMAKE_POLICY_VERSION_MINIMUM
# keeps old third-party CMakeLists configuring under CMake >= 4.
RUN cmake -S deps -B deps/build -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
    && targets="$(make -C deps/build -s help | grep -o 'dep_[A-Za-z0-9_]*' | sort -u \
            | grep -v -E '^dep_(wxWidgets|GLEW|GLFW|OpenCSG|WebView2|OpenSSL|CURL)$' | tr '\n' ' ')" \
    && echo "building: $targets" \
    && make -C deps/build -j"${JOBS:-$(nproc)}" $targets \
    && rm -rf deps/build/dep_* deps/build/DL_CACHE

# ---------------------------------------------------------------------------
FROM cxx-base AS libslic3r
ARG JOBS
# OrcaSlicer's top-level CMake requires DBus on Linux even with SLIC3R_GUI=OFF
# (nothing in libslic3r links it). Installed here rather than in cxx-base so the
# deps stage cache is not invalidated.
RUN apt-get update && apt-get install -y --no-install-recommends libdbus-1-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /orca
COPY --from=orca-deps /orca/deps/build/OrcaSlicer_dep deps/build/OrcaSlicer_dep
COPY extern/OrcaSlicer/CMakeLists.txt extern/OrcaSlicer/version.inc extern/OrcaSlicer/LICENSE.txt ./
COPY extern/OrcaSlicer/cmake cmake
COPY extern/OrcaSlicer/deps_src deps_src
COPY extern/OrcaSlicer/src src
COPY extern/OrcaSlicer/resources resources
# glfw3, curl and OpenSSL are required by OrcaSlicer's top-level CMake; stubs
# stand in for them (see docker/cmake-stubs/): the first two are GUI-only, and
# of OpenSSL libslic3r uses only MD5, from the standalone <openssl/md5.h> in
# cxx/shims (the WebAssembly engine's too). No OpenSSL on the C++ side at all.
COPY docker/cmake-stubs /orca/cmake-stubs
COPY cxx/shims /orca/farmslicer-shims
RUN cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DSLIC3R_GUI=OFF \
        -DCMAKE_PREFIX_PATH=/orca/deps/build/OrcaSlicer_dep/usr/local \
        -Dglfw3_DIR=/orca/cmake-stubs \
        -DCMAKE_MODULE_PATH=/orca/cmake-stubs \
        -DFARMSLICER_SHIMS_DIR=/orca/farmslicer-shims \
        -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
    && cmake --build build -j"${JOBS:-$(nproc)}" --target libslic3r libslic3r_cgal libnest2d \
    # Keep only what build.rs links against and the generated headers.
    && find build -name '*.o' -delete \
    && find build -type d -name CMakeFiles -prune -exec rm -rf {} +

# ---------------------------------------------------------------------------
FROM oven/bun:1 AS web
WORKDIR /app/web
COPY web/package.json web/bun.lock ./
RUN bun install --frozen-lockfile
COPY web ./
# The commit the web build names as its version (the context has no .git).
# After the install so a new commit doesn't redo it.
ARG GIT_SHA=""
# vite.config.ts writes to ../dist/web
RUN GIT_SHA="${GIT_SHA}" bun run build

# ---------------------------------------------------------------------------
FROM cxx-base AS server
ARG JOBS
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
        | sh -s -- -y --profile minimal --default-toolchain stable
WORKDIR /app
# build.rs expects the OrcaSlicer tree at extern/OrcaSlicer with the deps
# prefix and the cmake build dir in their in-tree locations.
COPY --from=libslic3r /orca/deps/build/OrcaSlicer_dep extern/OrcaSlicer/deps/build/OrcaSlicer_dep
COPY --from=libslic3r /orca/build extern/OrcaSlicer/build
COPY --from=libslic3r /orca/src extern/OrcaSlicer/src
COPY --from=libslic3r /orca/deps_src extern/OrcaSlicer/deps_src
COPY Cargo.toml Cargo.lock build.rs ./
COPY .cargo .cargo
COPY src src
COPY cxx cxx
# The Slice page's settings schema doubles as the overrides allowlist
# (src/config_policy.rs includes it).
COPY web/src/data web/src/data
RUN CARGO_BUILD_JOBS="${JOBS:-$(nproc)}" cargo build --release --locked \
    && strip target/release/farmslicer

# ---------------------------------------------------------------------------
FROM ubuntu:${UBUNTU_VERSION} AS runtime
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        libfontconfig1 ca-certificates tini curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=server /app/target/release/farmslicer /app/farmslicer
COPY --from=web /app/dist/web /app/dist/web
# Profiles and the small runtime tables libslic3r reads while slicing.
COPY extern/OrcaSlicer/resources/profiles /app/extern/OrcaSlicer/resources/profiles
COPY extern/OrcaSlicer/resources/info /app/extern/OrcaSlicer/resources/info
COPY extern/OrcaSlicer/resources/flush /app/extern/OrcaSlicer/resources/flush
# The thumbnail label font (SIL OFL).
COPY resources/fonts /app/resources/fonts
RUN mkdir -p /app/data && chown -R ubuntu:ubuntu /app/data
USER ubuntu
VOLUME ["/app/data"]
ENV PORT=9337 RUST_LOG=info
EXPOSE 9337
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -sf http://127.0.0.1:9337/api/health || exit 1
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/app/farmslicer"]
