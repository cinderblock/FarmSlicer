# Renovate batch, November 2026

Branch `deps/renovate-batch-2026-11` (worktree `C:\Users\camer\git\farmslicer-renovate-batch`).

## Goal

Land the nine open Renovate PRs (#16–#24) as one verified PR. Merging them one
at a time makes each later PR conflict on `Cargo.lock` / `web/bun.lock`. Do not
merge; the user ships by editing ops `pin.json`, so merging ships nothing anyway.

## Environment / context

- PR CI (`check` job in `.github/workflows/build.yml`) runs: `bun install
  --frozen-lockfile`, `bun run build`, `bun test` (in `web/`), `cargo check
  --locked`, `cargo test --locked` (both `FARMSLICER_SKIP_CXX=1`),
  `node scripts/third-party-notices.mjs --check`, `tests/run-e2e.sh`.
  The two-hour wasm and image jobs run on master only.
- Rust can't build on Windows here (vendored OpenSSL needs Strawberry Perl).
  Local Rust runs in WSL Ubuntu 24.04 (has cargo, make, gcc). FarmSlicer is
  not on the `rbuild` allow list, and buildhost is off-limits for this task.
- `openssl` crate stays: Web Push uses it too (`plans/openssl-in-deps.md`).

## Decisions (don't re-ask)

- rumqttc 0.25.1 pins rustls-webpki 0.102; its alerts were dismissed on
  purpose (custom `AcceptPrinterCert` verifier). Leave it.
- Superseded Renovate PRs may be closed once local verification passes (user's
  own repo, no merge gate).

## Findings

- Every Rust Renovate PR (and #24) failed CI only on
  `THIRD-PARTY-NOTICES.txt is out of date`: regenerate it in the batch.
- webauthn-rs 0.6 swaps OpenSSL for RustCrypto (`crypto-glue`). The stored
  `Passkey` JSON (`CredentialV5`) keeps the same fields; binary fields move
  from `HumanBinaryData` to serde_with `Base64<UrlSafe, Unpadded>`, the same
  wire encoding 0.5 wrote. 0.5 registered only ES256 and RS256
  (`secure_algs`), and 0.6 verifies both. 0.6 can't verify EdDSA or P-521
  and renamed `ES512` to `ES521` with no serde alias, but 0.5 never
  registered those here.

- tokio-tungstenite 0.30 (#18) and tower-http 0.7 (#19) would each be a
  second copy: axum 0.8.9 (latest) needs tokio-tungstenite ^0.29 and reqwest
  0.13.5 (latest) needs tower-http ^0.6.8. tungstenite 0.30's only fix is
  server-side, and our direct use is client-only. Left out; revisit with axum 0.9.
- TypeScript 7 (#22): `tsc -b` and the build pass, but eslint crashes
  (`Cannot read properties of undefined (reading 'Cjs')`): typescript-eslint
  8.72 peers `typescript >=4.8.4 <6.1.0`, and TS 7 has no JS compiler API.
  Tried `@typescript/typescript6` beside TS 7: any TS 6 package at the root
  links its own `tsc` bin over TS 7's (`tsc --version` gave 6.0.3). Left out.
- Lint already fails on master (15 problems, 14 errors); it isn't in CI.
- Ubuntu 26.04 (#23): default GCC 15 compiles C as C23. OrcaSlicer's deps
  superbuild builds GMP 6.2.1, whose configure fails under C23: with gcc 13
  and `CFLAGS=-std=gnu2x`, `configure: error: could not find a working
  compiler` (long long reliability test 1); default std passes. Left out;
  needs `-std=gnu17` for the C deps (or newer deps) and a real image build.
- React Router 8 needs React >=19.2.7: react/react-dom ^19.2.7 (19.3.1).
- New licence expression from RustCrypto: `CC0-1.0 OR MIT-0 OR Apache-2.0`.

## Progress

- [x] Rust: patch updates (#16), zip (#17), webauthn-rs 0.6 (#20) with
      `finish_discoverable_authentication_v2`
- [x] Web: @types/node 26 (#21), React Router 8 (#24)
- [x] THIRD-PARTY-NOTICES regenerated (+ MIT-0 text)
- [x] Verify (WSL Ubuntu 24.04): cargo check, cargo test (179 passed),
      clippy (no new warnings in touched code), tests/run-e2e.sh (all 20 pass);
      web: tsc -b + vite build, bun test 75/75, lint same 15 as master
- [x] Passkey upgrade test: ES256 + RS256 registered on master (0.5), both
      sign in on the batch (0.6), username and discoverable flows
- [x] PR #25 opened; #16 #17 #20 #21 #24 closed, notes left on #18 #19 #22 #23
- Left out: #18, #19, #22, #23 (see Findings)
