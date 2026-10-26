# OpenSSL 1.1.1 and libcurl out of the server binary

Branch `fix/openssl-1.1.1` (worktree `.t3/worktrees/Farm Slicer/fix-openssl-1.1.1`).
ISSUES.md entry: "The server binary links OrcaSlicer's OpenSSL 1.1.1w (and
libcurl)", claimed in `e4d464b`.

## Goal

The server binary statically links `libcrypto`, `libssl` and `libcurl` from
OrcaSlicer's deps superbuild, which pins `OpenSSL_1_1_1w`
(`extern/OrcaSlicer/deps/OpenSSL/OpenSSL.cmake:47`). OpenSSL 1.1.1 is out of
support (since 2023-09), and its OpenSSL/SSLeay licence is GPL-incompatible
while the binary is AGPL. The Rust side already vendors OpenSSL 3 (the
`openssl` crate, `vendored`, for webauthn-rs), so the binary carries two
OpenSSLs. Found by the licence audit (`plans/monetization-and-licensing.md`).

Preferred outcome: no 1.1.1 and no curl anywhere in the build; libslic3r's
crypto needs met by the one OpenSSL 3 the Rust side already links.

## Environment / context

- OrcaSlicer submodule pinned at v2.4.2; not to be patched in place.
- The Dockerfile is the reference build; full builds run on buildhost
  (Docker, 24 cores, shared: `JOBS=12`). Dev ports: 9338; 9337 is
  production, never touched.
- Rust `openssl-src` 300.6.1+3.6.3 (Cargo.lock), built with `no-shared`
  and without `no-deprecated`, so its `libcrypto.a` keeps `MD5_Init` & co.
- `openssl-sys` (`links = "openssl"`) publishes `DEP_OPENSSL_INCLUDE` and,
  when vendored, `DEP_OPENSSL_ROOT` (`<root>/lib/libcrypto.a`) to crates that
  depend on it directly.

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
  `libssl` is never used.
- `cxx/slice_core.cpp` includes `libslic3r/Utils.hpp`, so the bridge needs
  the header too.
- In the deps superbuild nothing depends on `dep_OpenSSL` or `dep_CURL`
  (only `dep_CURL` → `dep_OpenSSL`), so both can be left out of the target
  list without touching the submodule.
- The wasm engine stubs both packages (`wasm/cmake/Find{CURL,OpenSSL}.cmake`)
  and has its own `openssl/md5.h` shim; it shares nothing with this.
- MD5's API and `MD5_CTX` are the same in 1.1.1 and 3.x (deprecated in 3.0,
  still built by default). OpenSSL 3.x promises ABI compatibility across
  minor releases, so objects compiled against 3.0 headers link against 3.6.

## Decisions

- Keep the Rust side's vendored OpenSSL 3 as the one OpenSSL (current
  upstream, static, no system library needed on dev machines); point the
  C++ link at its `libcrypto.a`.
- Stop building `dep_OpenSSL`/`dep_CURL` in the Dockerfile's deps stage.
- libslic3r stage: Ubuntu's `libssl-dev` for the headers CMake's
  `find_package(OpenSSL)` wants (libslic3r is a static archive; nothing links
  there). Kept out of the deps stage so no third-party dep picks up a system
  OpenSSL by autodetection.
- curl: an empty `FindCURL.cmake` in `docker/cmake-stubs/`, first on
  `CMAKE_MODULE_PATH` (OrcaSlicer's own FindCURL module never tries config
  mode, so a `CURL_DIR` package config wouldn't be seen). No include
  directory, so any real use fails to compile rather than silently link.
- build.rs: bridge compiled with `DEP_OPENSSL_INCLUDE`; `libcrypto.a` from
  `DEP_OPENSSL_ROOT` inside the link group as a guard (see Verification:
  today libcrypto's own MD5 users already pull `md5_dgst.o` in); no
  `-lssl`, no `-lcurl`.

## Plan / steps

1. [x] Claim the ISSUES.md entry.
2. [x] Read libslic3r for curl/OpenSSL use (findings above).
3. [x] Dockerfile, build.rs, Cargo.toml (direct `openssl-sys`), cmake stub,
   CLAUDE.md native-build steps (the README doesn't describe the deps).
4. [x] Full image build on buildhost (scratch dir, `JOBS=12`).
5. [x] Prove it (Verification below).
6. [x] Close the ISSUES.md entry with the commit hash.

## Verification (buildhost, 2026-10-26)

Scratch context `~/farmslicer-openssl` (OrcaSlicer from `git archive` of
`~/orca-242`, a clean checkout at the pinned 8500fcd; this tree on top).
`docker build --build-arg JOBS=12 -t farmslicer:openssl-test .`:
`BUILD EXIT 0`, 3:35-3:51 PM PDT (22:35-22:51Z), deps stage included.

- Deps stage built `dep_Blosc dep_Boost dep_CGAL dep_Cereal dep_Draco
  dep_Eigen dep_FREETYPE dep_GMP dep_JPEG dep_MPFR dep_NLopt dep_OCCT
  dep_OpenCV dep_OpenEXR dep_OpenVDB dep_PNG dep_Qhull dep_TBB
  dep_libnoise`; no ssl/crypto/curl file under the deps prefix's `lib`
  (only Boost.Asio/Beast's SSL headers under `include`).
- `nm -u liblibslic3r.a`: the only crypto references are `MD5_Init`,
  `MD5_Update`, `MD5_Final` (utils.cpp, bbs_3mf.cpp). No archive under
  `/orca/build` or the deps `lib` references `curl_*` or `SSL_*`.
- Relink in the server stage (`cargo rustc --release --bin farmslicer --
  -C link-arg=-Wl,-Map=... -C link-arg=-Wl,--trace-symbol=MD5_Init ...`):
  `MD5_Init/Update/Final` defined by
  `libopenssl_sys-*.rlib(libcrypto-lib-md5_dgst.o)`, `OpenSSL_version_num`
  by `...(libcrypto-lib-cversion.o)`, i.e. the vendored 3.6.3. Every
  crypto member in the map (31,833 lines) comes from that rlib; no
  `libcrypto.a`, `libssl.a` or `libcurl.a` member at all. The unstripped
  binary has `EVP_MD_fetch` (3.x only) and no `curl_` symbol.
- `ldd /app/farmslicer`: libm, libstdc++, libgcc_s, libc, fontconfig and
  its freetype/expat/zlib/bzip2/png/brotli; no libssl/libcrypto/libcurl.
- Real server slices in the image (container `farmslicer-openssl-test` on
  127.0.0.1:9341, `FARMSLICER_NO_AUTH=1`, tmpfs data; script
  `~/fs-openssl-slice.py`): a 20 mm cube on X1C/PLA (980 s, 3.94 g) and a
  T with supports, PLA + Support For PLA interface (2265 s, 11.16 g, both
  filaments in the package). Both `done`, no warnings, packaged. The
  plate MD5 libslic3r wrote (`Metadata/plate_1.gcode.md5`, through
  OpenSSL 3's `MD5_*`) matches Python's `hashlib.md5` of the plate G-code
  for both. Container stopped afterwards.
- `cargo test --release --locked` in the server stage (real bridge linked):
  178 passed, 0 failed, 1 ignored.
- wasm: not rebuilt. `wasm/` reads none of the changed files (it has its own
  stubs, `wasm/cmake/Find{CURL,OpenSSL}.cmake`, and an `openssl/md5.h`
  shim), and no `wasm/` or `cxx/` file changed; CI's wasm job builds and
  smoke-tests it on push.

Late findings:

- `strings` can't tell the old binary from the new: static linking only
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
- buildhost leftovers: `~/farmslicer-openssl`, `~/fs-openssl-slice.py`,
  `/tmp/fs-openssl-*`, images `farmslicer:openssl-test{,-server,-libslic3r}`.

## Progress log

- [x] `e4d464b` ISSUES: claim.
- [x] `7f41159` the fix (Dockerfile, build.rs, Cargo.toml/lock, FindCURL
  stub, CLAUDE.md).
- [x] ISSUES entry removed, naming `7f41159`.

## Open questions for the user

1. Push the branch / open a PR? Not done; waiting on your say.
2. Windows: `link_windows_libs` now relies on openssl-sys's libcrypto too.
   Untested, like everything on Windows since the v2.4.2 bump.
3. Clean up the buildhost leftovers above? (Recommend: yes, once merged.)

## Things not to do

- Don't patch `extern/OrcaSlicer` in place.
- Don't install `libssl-dev` in `cxx-base`/`orca-deps`: deps could autodetect
  it and link a second OpenSSL.
- Never touch the production container or port 9337 on buildhost.
- Don't trust `strings`/version greps to prove which OpenSSL is linked; use
  a link map.
