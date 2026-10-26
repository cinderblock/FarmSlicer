# OpenSSL 1.1.1 and libcurl out of the server binary

Branch `fix/openssl-1.1.1` (worktree `.t3/worktrees/Farm Slicer/fix-openssl-1.1.1`).
ISSUES.md entry: "The server binary links OrcaSlicer's OpenSSL 1.1.1w (and
libcurl)", claimed in `e4d464b`, removed in `0a54da9`.

## Goal

The server binary statically linked `libcrypto`, `libssl` and `libcurl` from
OrcaSlicer's deps superbuild, which pins `OpenSSL_1_1_1w`
(`extern/OrcaSlicer/deps/OpenSSL/OpenSSL.cmake:47`). OpenSSL 1.1.1 is out of
support (since 2023-09), and its OpenSSL/SSLeay licence is GPL-incompatible
while the binary is AGPL. The Rust side already vendors OpenSSL 3 (the
`openssl` crate, `vendored`, for webauthn-rs and Web Push), so the binary
carried two OpenSSLs. Found by the licence audit
(`plans/monetization-and-licensing.md`).

Outcome wanted (the user, after round 1: "why do we have so many OpenSSL?
let's clean that up"): no curl and no OpenSSL on the C++ side at all, in
the build or the binary; the Rust side's vendored OpenSSL 3 the only one.

## Environment / context

- OrcaSlicer submodule pinned at v2.4.2; not to be patched in place.
- The Dockerfile is the reference build; full builds run on buildhost
  (Docker, 24 cores, shared: `JOBS=12`). Dev ports: 9338; 9337 is
  production, never touched.
- Rust `openssl-src` 300.6.1+3.6.3 (Cargo.lock).
- wasm toolchain on buildhost: `~/wasm-ref/wasm-deps/env.sh`.

## Findings

What headless libslic3r uses (read from the v2.4.2 sources):

- **curl: nothing.** No `curl/` include or `curl_*` call in `src/libslic3r`
  or `deps_src`. Only the top-level `CMakeLists.txt` asks for it
  (`find_package(CURL REQUIRED)`, line 633) and wraps it in an INTERFACE
  target `libcurl` that only the GUI and the profile validator link.
- **OpenSSL: MD5 only.** `Utils.hpp:18` and `Format/bbs_3mf.cpp:40` include
  `<openssl/md5.h>`; `utils.cpp:1603` (`bbl_calc_md5`) and
  `bbs_3mf.cpp:6383` call `MD5_Init/MD5_Update/MD5_Final`.
  `src/libslic3r/CMakeLists.txt:606` links `OpenSSL::Crypto` for that.
  `libssl` is never used. Nothing includes `<openssl/sha.h>` any more (the
  wasm shim for it was left over from an older OrcaSlicer).
- `libslic3r_cgal` includes `Utils.hpp` without linking `OpenSSL::Crypto`:
  upstream counts on OpenSSL's headers being on the default include path.
  Round 2's first build failed exactly there (`fatal error: openssl/md5.h:
  No such file or directory`, `IntersectionPoints.cpp`), so the stub also
  sets the include directory for the calling directory.
- `cxx/slice_core.cpp` includes `libslic3r/Utils.hpp`, so the bridge needs
  the header too.
- In the deps superbuild nothing depends on `dep_OpenSSL` or `dep_CURL`
  (only `dep_CURL` → `dep_OpenSSL`), so both can be left out of the target
  list without touching the submodule.
- OrcaSlicer's own `cmake/modules/FindCURL.cmake` never tries config mode,
  so a stub must be a find-module ahead of it on `CMAKE_MODULE_PATH`
  (OrcaSlicer appends its modules), not a `CURL_DIR` package config.
- The wasm engine already had a standalone, header-only RFC 1321 MD5
  (`wasm/shims/openssl/md5.h`, C++ `inline` functions: mangled names, so no
  clash with libcrypto's C `MD5_*`). Its comment cited a
  `wasm/tests/md5_selftest.cpp` that doesn't exist.
- `strings` can't tell an old binary from a new one: static linking only
  pulls referenced members, and neither carries an "OpenSSL x.y.z" string
  or any curl code (curl was linked but never referenced, so production's
  binary had none of it either). The link map and `--trace-symbol` are the
  proof that works.
- rustc bundles openssl-sys's `libcrypto.a` into its rlib, so the map names
  `libopenssl_sys-*.rlib(libcrypto-lib-*.o)`, not `libcrypto.a`.
- The image's cargo registry lacks dev-dependencies: `cargo test --offline`
  in the server stage fails (`failed to download asn1-rs`); run it online.
- Changing the deps stage invalidates its layer: the first CI image build
  after this rebuilds the deps (buildhost: ~15 min at JOBS=12).

## Decisions (current)

- The binary's only OpenSSL: the Rust side's vendored OpenSSL 3. Rust can't
  drop it (webauthn-rs requires the `openssl` crate; Web Push uses it).
- C++ side: no OpenSSL. libslic3r's `<openssl/md5.h>` is the standalone
  MD5, moved to `cxx/shims/openssl/md5.h` and shared by both engines
  (`wasm/CMakeLists.txt` and build.rs include `cxx/shims`). Every package is
  cross-checked anyway: `src/package/bambu.rs` compares the `.md5` entry
  with its own MD5 of the plate's G-code.
- Deps stage: no `dep_OpenSSL`/`dep_CURL`.
- `docker/cmake-stubs/FindCURL.cmake` (empty) and `FindOpenSSL.cmake`
  (`OpenSSL::Crypto` = the shim's include directory, also set for the
  calling directory; `OpenSSL::SSL` empty; `FARMSLICER_SHIMS_DIR`, default
  `cxx/shims` relative to the stub), via `-DCMAKE_MODULE_PATH`.
- No `libssl-dev`, no direct `openssl-sys` dependency, no OpenSSL include
  or link in build.rs.
- Round 1 (`7f41159`) had linked libslic3r's MD5 against the Rust side's
  libcrypto, compiled against Ubuntu's 3.0 headers (libslic3r) and the
  vendored 3.6 headers (bridge): one OpenSSL in the binary but three sets of
  OpenSSL headers in the build. Round 2 replaces that.

## Plan / steps

1. [x] Claim the ISSUES.md entry.
2. [x] Read libslic3r for curl/OpenSSL use (findings above).
3. [x] Round 1: OpenSSL 1.1.1/curl out, MD5 from the Rust side's OpenSSL 3
   (`7f41159`), proved, ISSUES entry closed (`0a54da9`).
4. [x] Round 2: shared MD5 shim, FindOpenSSL stub, libssl-dev/openssl-sys
   out; image rebuilt and proved (below).
5. [x] Round 2: wasm st + mt built from this tree, st smoke tests.
6. [x] Commit round 2.

## Verification

Scratch context on buildhost: `~/farmslicer-openssl` (OrcaSlicer from `git
archive` of `~/orca-242`, a clean checkout at the pinned 8500fcd; this tree
on top). `docker build --build-arg JOBS=12 -t farmslicer:openssl-test .`.

Round 1 (2026-10-26, 3:35-3:51 PM PDT (22:35-22:51Z), deps stage included):

- Deps stage built `dep_Blosc dep_Boost dep_CGAL dep_Cereal dep_Draco
  dep_Eigen dep_FREETYPE dep_GMP dep_JPEG dep_MPFR dep_NLopt dep_OCCT
  dep_OpenCV dep_OpenEXR dep_OpenVDB dep_PNG dep_Qhull dep_TBB
  dep_libnoise`; no ssl/crypto/curl file under the deps prefix's `lib`.
- Link trace: `MD5_*` from `libopenssl_sys-*.rlib(libcrypto-lib-md5_dgst.o)`
  (3.6.3); no other libcrypto/libssl/libcurl; slices and MD5s good;
  `cargo test` 178 passed.

Round 2 (2026-10-26, deps layer cached; libslic3r and server rebuilt):

- `BUILD EXIT 0`. No `/usr/include/openssl` in the libslic3r stage.
- No archive under `/orca/build` has an undefined `MD5_`/`SHA*_`/`EVP_`/
  `SSL_`/`CRYPTO_`/`OPENSSL_`/`curl_` symbol. `liblibslic3r.a`'s MD5 is the
  shim's: local C++ symbols `MD5_Update(MD5state_st*, ...)`,
  `MD5_Final(unsigned char*, MD5state_st*)`, `orca_wasm_md5::block`.
- Relink with `-Wl,-Map` and `--trace-symbol=MD5_Init`: every reference to
  the C `MD5_Init` is inside the vendored OpenSSL itself (`md5_sha1.o`,
  `e_rc4_hmac_md5.o`, `md5_prov.o`, ...), none from libslic3r or the bridge.
  No `libcrypto.a`/`libssl.a`/`libcurl.a` in the map; no `curl_` symbol.
- `ldd`: no ssl/crypto/curl.
- Real server slices (container on 127.0.0.1:9341, `~/fs-openssl-slice.py`):
  cube on X1C/PLA 980 s, 3.94 g; T with supports, PLA + Support For PLA
  interface 2265 s, 11.16 g (identical to round 1); both `done`, no
  warnings; the plate MD5 libslic3r wrote with the shim matches Python's
  `hashlib.md5` for both. Container stopped.
- `cargo test --release --locked` (real bridge): 178 passed, 0 failed,
  1 ignored.
- wasm: `~/farmslicer-openssl-wasm.sh` → `bash wasm/build.sh all` with
  `ORCA_SRC_DIR=~/farmslicer-openssl-wasm-orca` (fresh archive, patch
  applied), `OUT_DIR=~/farmslicer-openssl-wasm-out`, `NPROC=8`: `WASM EXIT
  0`, st and mt engines + manifest (4:16 PM PDT (23:16Z)). Every compile
  line has `-isystem .../cxx/shims`; `mt_shims` now holds only `openvdb`,
  and no other `openssl/md5.h` exists on the wasm include paths (deps
  prefixes, `wasm/shims`), so both variants compiled the shared shim. CI's
  three st smoke tests (one model, `--plate`, `--plates`) all exit 0; a
  `--package` run (a throwaway copy of smoke.mjs that also saved the
  package) gives a plate MD5 matching Python's. mt not run: it doesn't
  finish under Node (Known Issues), as before.

## Progress log

- [x] `e4d464b` ISSUES: claim.
- [x] `7f41159` round 1 (Dockerfile, build.rs, Cargo.toml/lock, FindCURL
  stub, CLAUDE.md).
- [x] `0a54da9` ISSUES entry removed, naming `7f41159`; this plan.
- [x] Round 2 commit (no OpenSSL on the C++ side).

## Open questions for the user

1. Push the branch / open a PR? Not done; waiting on your say.
2. Windows: the Windows link no longer names any crypto library (the C++
   side needs none). Untested, like everything on Windows since the v2.4.2
   bump.
3. Clean up the buildhost leftovers? `~/farmslicer-openssl`,
   `~/farmslicer-openssl-wasm-orca`, `~/farmslicer-openssl-wasm-out`,
   `~/farmslicer-openssl*.sh`/`.log`, `~/fs-openssl-slice.py`,
   `/tmp/fs-openssl-*`, images `farmslicer:openssl-test{,-server,-libslic3r}`.
   (Recommend: yes, once merged.)

## Things not to do

- Don't patch `extern/OrcaSlicer` in place.
- Don't put `wasm/shims` itself on a native include path: it holds TBB and
  Boost shims too. Only `cxx/shims` (just `openssl/`).
- Don't install `libssl-dev` anywhere in the image: nothing needs it now,
  and in `cxx-base`/`orca-deps` a dep could autodetect it.
- Never touch the production container or port 9337 on buildhost.
- Don't trust `strings`/version greps to prove which OpenSSL is linked; use
  a link map.
