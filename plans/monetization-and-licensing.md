# Monetization and licensing: what AGPL allows, what to sell, what to fix

`plans/monetization-and-licensing.md`

Research written October 26, 2026 (US Pacific). Not legal advice: it is a map
of the facts in this repository and of the market, to take to a lawyer before
selling anything.

## Goal

The maintainer wants FarmSlicer to stay fully open source and to earn money from
it through:

- a managed, pre-set-up version: a box, or an install service for print farms,
  makerspaces and schools;
- cloud-hosted instances (SaaS);
- possibly support contracts.

A public demo (`demo.farmslicer.com`) and a project site (`farmslicer.com`) are
planned.

This document answers three questions:

1. What license FarmSlicer is under, and what fixes it there.
2. What that license demands of each business model.
3. What comparable projects and vendors charge, and what to sell first.

## Decisions already made (don't re-ask)

Answers from the maintainer, 2026-10-26:

- **No trademark filing before there is revenue.** The free steps are fine:
  use the name consistently (rights in a mark accrue with use) and publish
  a trademark policy.
- **Bambu restricting third-party access isn't a concern.**
- **Hosted versions:** agreed, as the later step.
- **A company already exists** (a C corp); whether to sell under it is an
  open question below.
- **The in-app "Source code" link:** done (`69c5cd5`).
- **The licence paperwork** (notices, licence fields, wrong credits): done
  (`e33c930`..`59b303e`, linked from the app in `2cb379e`;
  `plans/licence-paperwork.md`). **The OpenSSL 1.1.1 issue** has its own
  thread (branch `fix/openssl-1.1.1`).
- **The demo** is deferred to its own thread (see `plans/demo.md`).

## Findings: licensing

### What FarmSlicer declares

| Where | What it says |
| --- | --- |
| `LICENSE` | The verbatim GNU AGPL v3 text. It has no copyright line and no "or later" notice. |
| `README.md` (line 146) | "License: AGPL-3.0-or-later (inherited from libslic3r)." |
| `CLAUDE.md` | "AGPL-3.0 (inherited from libslic3r)". |
| `.github/workflows/build.yml` | Image label `org.opencontainers.image.licenses=AGPL-3.0-or-later` (good). |
| GitHub (`cinderblock/FarmSlicer`, public) | Detects `agpl-3.0`. |
| `Cargo.toml` | **No `license` field.** `cargo metadata` reports `farmslicer` with no license. |
| `web/package.json` | **No `license` field.** It is `"private": true`, so this is cosmetic. |
| Source files (`src/`, `cxx/`, `wasm/bridge/`, `web/src/`) | **No SPDX or license headers.** |
| `wasm/LICENSE.txt` | "GNU Affero General Public License v3.0". |

FarmSlicer is AGPL-3.0, and the README claims "or later".

### "Only" or "or later"?

- **OrcaSlicer**, which supplies libslic3r:
  - `extern/OrcaSlicer/LICENSE.txt` is the plain AGPL v3 text.
  - Its README says "licensed under the GNU Affero General Public License, version 3", with no "or later".
  - Inside `src/libslic3r`, 55 files carry PrusaSlicer's header "released under the terms of the AGPLv3 or higher".
  - Most files carry no header at all.
  - `Geometry/ArcWelder.cpp` (from ArcWelderLib) says "(at your option) any later version".
- **The combined work** (the server binary, the wasm engine, the Docker image) can only be relied on as **AGPL-3.0**. That is the version OrcaSlicer's project-level notice names, and it is the only version every contributor demonstrably agreed to.
- **FarmSlicer's own code** can be offered under AGPL-3.0-or-later, which is what the README claims. That is consistent, but the README should say *both* things. See the recommendation.

### Why FarmSlicer must stay AGPL

FarmSlicer links libslic3r statically into its server binary (`build.rs`:
`libslic3r`, `libslic3r_cgal`) and compiles it into the wasm engine shipped to
browsers. Both are derivative works of OrcaSlicer, BambuStudio, PrusaSlicer and
Slic3r, which are AGPL-3.0.

- This alone forces every distributed or network-served build to be AGPL-3.0.
- Several C++ dependencies are GPL-3.0-or-later as well: CGAL's mesh packages, MCUT, and admesh (GPL-2.0-or-later). GPLv3 §13 and AGPLv3 §13 allow them to be combined with AGPL code, so they don't change the outcome. They only add more copyleft holders.

### Could FarmSlicer ever relicense (MIT/Apache, or dual-license)?

**No, not as long as it contains libslic3r.**

- **What blocks it:** the slicer's copyright is held by thousands of contributors across four projects. There is no CLA in any of them that would let anyone relicense. The GPL-only CGAL packages (commercial licences sold by GeometryFactory) and MCUT (commercial licence offered) add more holders to clear.
- **What the maintainer owns:** FarmSlicer's own code. All 228 commits so far are the maintainer's, and there is no outside contributor yet.
- **What would have to be separated out first:**
  - `wasm/` build pieces adapted from `JoshTheDerf/orcaslicer-wasm`, which is a fork of `allanwrench28/orcaslicer-wasm` (AGPL, other people's copyright). The README credits only JoshTheDerf, while `wasm/LICENSE.orcaslicer-wasm` names allanwrench28.
  - `wasm/patches/orca-wasm.patch`, a modification of OrcaSlicer.
  - Anything in `cxx/slice_core.cpp` copied from OrcaSlicer's CLI. CLAUDE.md says purge volumes follow "the CLI's method", so check whether that is copied code or a reimplementation.
  - The G-code allowlists in `src/gcode/data/*.json`, derived from OrcaSlicer's AGPL vendor profiles.
- **What the maintainer could do with their own code:** dual-license *their own* parts that never touch libslic3r, for example the printer drivers as a permissive library. That works only if they are first made into a separate program or library. It doesn't change the license of FarmSlicer as shipped.
- **AI-assisted code:** most commits are co-authored with an AI assistant. US copyright protects only human authorship (Copyright Office guidance, 2023 and 2025). That doesn't threaten the AGPL, which libslic3r carries regardless. It does weaken any plan that depends on exclusive ownership of FarmSlicer's own code, such as selling proprietary licences of it. Another reason not to build the business on relicensing.

### Compliance gaps in the repository today

1. **No source offer in the app (AGPL §13).** The UI never links to the source.
   - The only version shown is `BUILD_VERSION`, in the What's New dialog (`web/src/components/WhatsNewDialog.tsx:49`), with the commit as a tooltip.
   - `/version.json` has the commit, but nothing points users to the source.
   - The only GitHub URL in the code is a client-info string sent to Moonraker (`src/moonraker/link.rs:349`).
   - This matters most for the demo and for any hosted instance.
2. **The wasm engine is distributed object code (GPL/AGPL §6).**
   - Every browser that loads the Slice page receives `farmslicer-engine*.wasm` plus a `.data` file preloading `resources/info`, `resources/flush` and the Sarabun font (`wasm/CMakeLists.txt:206-211`).
   - That is conveyance, not just network use, so the server must offer Corresponding Source. That includes:
     - the patch;
     - `wasm/build.sh`;
     - `wasm/toolchain/*.sh`;
     - the deps' sources (GMP, MPFR, CGAL, Boost, NLopt, libnoise, Qhull, Expat, oneTBB, heatshrink, ...) or exact pointers to them.
   - The repository has all the scripts. The dep tarballs come from upstream URLs that FarmSlicer doesn't control.
3. **OpenSSL 1.1.1w is linked into the server binary.**
   - OrcaSlicer's deps superbuild builds `dep_OpenSSL` from `OpenSSL_1_1_1w.tar.gz` when no system OpenSSL is found. This is the case in the Docker `orca-deps` stage (`extern/OrcaSlicer/deps/OpenSSL/OpenSSL.cmake:47`).
   - `build.rs` links its `libcrypto`/`libssl` (and `libcurl`) into the binary.
   - OpenSSL 1.x is under the OpenSSL/SSLeay licence, whose advertising clause the FSF calls GPL-incompatible. GPLv3's system-library exception doesn't cover a statically linked copy built from source.
   - OpenSSL 1.1.1 has also been out of support since September 2023.
   - The Rust side separately vendors OpenSSL **3.6.3** (`openssl-src 300.6.1+3.6.3`, Apache-2.0, which is GPLv3-compatible).
   - Fix: build the deps with OpenSSL 3.x, or drop curl/OpenSSL from libslic3r's link if nothing in the headless build needs them. That also removes two OpenSSL copies in one binary. It is a build change, so it is logged here rather than diagnosed.
4. **No third-party notices accompany the binaries.** *Addressed: `THIRD-PARTY-NOTICES.txt`, see `plans/licence-paperwork.md`.*
   - MIT, BSD, Apache-2.0, Unicode-3.0, CDLA-Permissive-2.0, OFL, the FreeType License (credit clause) and the LGPLs all require their notices to travel with the binary or the image.
   - The image ships none, and the JS bundle has no licences page.
5. **Missing license metadata:** *Addressed (metadata and `NOTICE`; no SPDX headers yet): `plans/licence-paperwork.md`.*
   - `Cargo.toml` and `web/package.json` have no `license` field.
   - There are no SPDX headers.
   - `LICENSE` lacks a copyright and "or later" notice, so the README's "or later" claim is the only place it is made.
6. **A stale, contradictory notice was copied in.** *Addressed: annotated, both repositories credited (`plans/licence-paperwork.md`).* `wasm/NOTICE.orcaslicer-wasm.md` says "Licensing will be added later. Until a LICENSE file is added, all rights reserved."
   - Upstream (`allanwrench28/orcaslicer-wasm`, checked via the GitHub API) still has that `NOTICE.md` *next to* a `LICENSE` that grants AGPL-3.0-or-later.
   - The LICENSE supersedes the notice by the notice's own wording, and the work is an OrcaSlicer derivative either way.
   - Shipping the notice still invites doubt: annotate it or drop it, and credit both upstream repos in the README.
7. **Bambu's HMS data has no licence.**
   - `src/bambu/data/hms.json` is harvested by `harvest-hms.mjs` from `https://e.bambulab.com/query.php`, the endpoint Bambu Studio and OrcaSlicer query at run time.
   - It is Bambu's text, with no licence or terms granted.
   - The risk is small: short factual error messages, used for interoperability, attributed to their source. But it is the one bundled dataset FarmSlicer has no right to.
   - Options: fetch it at run time as the slicers do, ship it with a clear attribution and a takedown promise, or ask Bambu.

## Dependency license audit

### C++ linked into the server binary (`build.rs`) and, where marked, into the wasm engine

| Component (version) | License | Copyleft? | Linked | Notes |
| --- | --- | --- | --- | --- |
| libslic3r, OrcaSlicer v2.4.2 (`extern/OrcaSlicer`) | AGPL-3.0 (some files "or higher") | **Strong, network** | static, wasm | Decides the license of the whole |
| CGAL 5.6.3 (wasm also 6.1) | Kernel LGPL-3.0+. Polygon_mesh_processing, Surface_mesh, mesh_segmentation, triangulations, arrangements GPL-3.0+ (commercial from GeometryFactory) | **Strong** | static, wasm | libslic3r includes PMP (9×), Surface_mesh, mesh_segmentation, Constrained_Delaunay_triangulation_2, Arr_segment_traits_2 |
| MCUT (`deps_src/mcut`) | GPL-3.0 or commercial | **Strong** | static, wasm | Mesh boolean ops |
| admesh (`deps_src/admesh`) | GPL-2.0-or-later | **Strong** | static, wasm | "or later" makes it GPLv3-compatible |
| minilzo (`deps_src/minilzo`) | GPL-2.0-or-later | Strong | built, **not** in `build.rs`'s link list | Desktop-only, apparently |
| libnest2d (`deps_src/libnest2d`) | LGPL-3.0 | Weak | static | Arrange (native only) |
| GMP 6.2.1 | LGPL-3.0+ / GPL-2.0+ | Weak | static, wasm | Static LGPL is satisfied by shipping full source and build scripts |
| MPFR 4.2.2 | LGPL-3.0+ | Weak | static, wasm | As above |
| OCCT 7.6.0 | LGPL-2.1 + OCCT exception | Weak | static | STEP import |
| NLopt 2.5.0 (wasm 2.9.1) | MIT core, some algorithms LGPL-2.1 | Weak | static, wasm | |
| libnoise 1.0 (Orca fork) | LGPL-2.1 | Weak | static, wasm | |
| OpenVDB (tamasmeszaros fork, pre-Apache) | MPL-2.0 | File-level | static | Newer upstream OpenVDB moved to Apache-2.0 |
| Eigen 5.0.1, libigl | MPL-2.0 | File-level | header-only, wasm | |
| oneTBB 2021.5 | Apache-2.0 | No | static, wasm-mt | |
| Boost 1.84 | BSL-1.0 | No | static, wasm | |
| OpenCV 4.6.0 (`opencv_world`) | Apache-2.0 (bundled 3rdparty: BSD/zlib) | No | static | |
| Draco 1.5.7 | Apache-2.0 | No | static | |
| Blosc 1.17, OpenEXR/Half 2.5.5 | BSD-3-Clause | No | static | |
| Qhull 8.0.2 | Qhull licence (permissive) | No | static, wasm | |
| Clipper, Clipper2 | BSL-1.0 | No | static, wasm | |
| glu-libtess | SGI Free Software License B 2.0 | No | static | GPL-compatible |
| Cereal 1.3.0 | BSD-3-Clause | No | header-only, wasm | |
| Expat, miniz, qoi, semver, nanosvg | MIT / zlib | No | static, wasm | |
| FreeType 2.12.1 | FTL or GPL-2.0 | No (FTL) | static | FTL has a credit clause |
| libpng 1.6.35, zlib 1.2.11, libjpeg-turbo 3.0.1 | libpng / zlib / IJG+BSD | No | static | |
| libcurl 7.75.0 | curl (MIT-like) | No | static | Old version |
| **OpenSSL 1.1.1w** (Orca deps) | **OpenSSL/SSLeay** | No, but **GPL-incompatible** | static | **Gap 3.** Also end of life |
| fontconfig | MIT-like | No | dynamic (system) | |
| glibc, libstdc++ | LGPL / GPL + runtime exception | system libraries | dynamic | Excluded from Corresponding Source |

None of these forbid AGPL distribution except OpenSSL 1.1.1 (gap 3).

The GPL and LGPL parts mean the shipped program must stay under a GPL-family
licence even if libslic3r somehow didn't. The licence has to be AGPL-3.0 because
of libslic3r.

### Rust crates

Source: `cargo metadata --format-version 1 --locked`, 345 resolved packages,
all targets.

| License | Count | Packages of note |
| --- | --- | --- |
| MIT and/or Apache-2.0 (all spellings) | ~285 | |
| MIT / Apache / ISC / BSD / Zlib / 0BSD / BSL / Unlicense variants | ~40 | `ring` (Apache-2.0 AND ISC), `rustls*`, `subtle`, `matchit`, `encoding_rs` |
| Unicode-3.0 | 18 | `icu_*`, `zerovec`, `yoke` (notice required) |
| **MPL-2.0** | 5 | `webauthn-rs`, `webauthn-rs-core`, `webauthn-rs-proto`, `webauthn-attestation-ca`, `base64urlsafedata` |
| CDLA-Permissive-2.0 | 1 | `webpki-roots` (Mozilla's root list; include the licence text) |
| MIT OR Apache-2.0 OR LGPL-2.1+ | 2 | `r-efi` (take MIT) |
| Bundled C | | SQLite via `libsqlite3-sys` (public domain). OpenSSL 3.6.3 via `openssl-src` (Apache-2.0) |
| (none) | 1 | `farmslicer` itself: gap 5 |

No GPL, AGPL, EPL or CDDL crates.

MPL-2.0 is file-level copyleft and explicitly compatible with (A)GPL. FarmSlicer
uses webauthn-rs unmodified, so the only duty is to tell recipients where its
source is, which third-party notices do.

### npm (web)

Source: every `package.json` under `web/node_modules`, 210 packages, which
includes dev tools.

| License | Count | Shipped to browsers? |
| --- | --- | --- |
| MIT | 166 | Runtime deps: `react`, `react-dom`, `react-router`, `three`, `@react-three/fiber`, `@react-three/drei` and its tree, `@simplewebauthn/browser` (all MIT) |
| Apache-2.0, ISC, BSD-2/3, 0BSD | 39 | some |
| MPL-2.0 | 2 | `lightningcss` (Vite's CSS tool): build only |
| CC-BY-4.0 | 1 | `caniuse-lite`: build only |
| BlueOak-1.0.0 | 1 | `minimatch`: build only |
| no `license` field | 1 | `webgl-constants@1.1.1` (from `detect-gpu`, via drei): its `LICENSE` file is MIT |

No copyleft reaches the browser bundle except FarmSlicer's own AGPL code and the
wasm engine.

### Bundled data

| Data | Source / licence | Notes |
| --- | --- | --- |
| Vendor profiles, `resources/profiles` (133 entries, about 11k profiles) | Part of OrcaSlicer's repository, AGPL-3.0 as distributed. Many were contributed by printer vendors. | Fine to ship. Vendors' names are their trademarks: use them nominatively only. |
| `resources/info`, `resources/flush` | OrcaSlicer, AGPL-3.0 | In the image and in the wasm `.data` |
| `resources/fonts/Sarabun-SemiBold.ttf` | SIL OFL 1.1 (`resources/fonts/OFL.txt`) | The image ships OFL.txt. The wasm `.data` preloads only the TTF: add OFL.txt to the notices page. |
| `src/gcode/data/orca.json`, `bambustudio.json` (harvested) | Derived from OrcaSlicer and BambuStudio vendor profiles, both AGPL-3.0 | Fine: AGPL into AGPL |
| `src/gcode/data/slicer.json`, `printers.json` | FarmSlicer's own | |
| `src/bambu/data/hms.json` | Bambu Lab's server (`e.bambulab.com`). No licence. | Gap 7 |

## AGPL obligations per business model

AGPL-3.0 is GPL-3.0 plus §13: anyone who runs a *modified* version for users
over a network must prominently offer those users the Corresponding Source of
the version they are using.

The maintainer holds the copyright on FarmSlicer's own code and so isn't bound
by its licence. They *are* bound by libslic3r's AGPL, and FarmSlicer as a whole is
a modified version of it: patched for wasm, and combined with new code. Treat
§13 as binding on every instance they run.

### Hosted instances and SaaS (including the demo)

- **Required (§13):** a prominent source offer in the UI for the exact running version.
  - Concretely: a "Source code" link in the sidebar footer and the What's New dialog, pointing to `https://github.com/cinderblock/FarmSlicer/tree/<BUILD_COMMIT>`, next to the version.
  - Make the base URL configurable, e.g. `FARMSLICER_SOURCE_URL`, defaulting to the upstream repository, so a modified deployment points at *its* source. Third-party hosts are bound by §13 too.
  - A served build must therefore be a pushed commit:
    - never a `-dirty` build;
    - a commit that is in the public repository, which CI's `GIT_SHA` builds already ensure.
- **Required (§6), because of the wasm engine:** the same link covers it, provided the repository at that commit holds the complete Corresponding Source:
  - the submodule pin;
  - the patch;
  - the toolchain scripts;
  - the dep versions and URLs.

  Upstream tarball URLs can disappear. For long-term compliance, publish a source bundle for each release: the repository at the tag, the submodule, and the downloaded dep archives (Orca's `DL_CACHE` and `wasm/toolchain` downloads), for example as a GitHub release asset.
- **Recommended:** a `/licenses` page (or `/licenses.txt`) with FarmSlicer's licence and the third-party notices. Generate it with `cargo about` for Rust, a Vite licence plugin for the bundle, and a hand-kept list for the C++ deps. Do the same as a `THIRD_PARTY_NOTICES` file in the image.
- **Allowed:**
  - Charging for hosting, support, uptime, backups, onboarding.
  - Keeping private:
    - customer data;
    - the infrastructure code that runs the fleet (provisioning, billing, monitoring), **as long as it is a separate program** talking to FarmSlicer at arm's length (HTTP API, the process boundary), not linked into it or patched into it.
- **Not allowed:** closed-source features inside the FarmSlicer server or web app. Any feature users of a hosted instance interact with must be in the offered source. There can be no hidden "enterprise" module linked into the binary.
- **Consequence:** anyone, competitors included, may host FarmSlicer and charge for it, as long as they offer their source. The licence doesn't protect the hosting business: the trademark, the quality of the service, and being the upstream do.

### Managed boxes (pre-installed hardware) and install services

- Selling a box with FarmSlicer on it is distribution of object code. GPLv3 §6 applies to the server binary, the image and the wasm engine. Satisfy it with one of:
  - source on the device;
  - a written offer valid for 3 years;
  - "equivalent access" from a network server you keep up.

  Simplest: a printed sheet and a page on the device that link to the exact commit, plus the release source bundle above.
- **Installation Information (§6, "User Products"):** a mini-PC is a kind of product normally used in homes, so it is very likely a User Product even when a school buys it. The buyer must be able to install a modified FarmSlicer on it. Don't lock the box: no signed-boot lock-in, give the owner root or a documented reflash path.
- The rest of the box's software (OS, Docker, a management agent) can be anything. That is "mere aggregation" (§5) as long as the management agent is a separate program.
- **An install service on the customer's own hardware is not distribution by the maintainer.** The customer receives the software from the public repository or image, so it needs no extra compliance beyond what the hosted version needs.

### Support contracts

No licence constraint. Support, SLAs, consulting and custom drivers are services.

- Custom work delivered to one customer and deployed for their users falls under §13 on *their* deployment, so it will end up offered as source.
- Plan for custom work to land upstream. That is a feature: customers fund the roadmap.

### Trademark: the real moat

The code is free for everyone. The name and logo are what customers recognize.

Plausible (AGPL) registered US and EU marks to stop resellers trading on its
name. Elastic re-added AGPL in 2024 once its trademark dispute with AWS was
settled, which suggests the fight was always over the name.

- **Search first.** `plans/naming.md` notes no USPTO/EUIPO search has been done yet.
- **File** "FarmSlicer" (word mark) at the USPTO in class 9 (downloadable software) and class 42 (SaaS).
  - From January 18, 2025 the base fee is **$350 per class**, so about $700.
  - $200 more per class for a free-text description: use the ID Manual entries.
  - The logo can follow later.
- **Publish `TRADEMARKS.md`**, modelled on Mozilla's policy (no trademark rights come with the code licence):
  - Unmodified or lightly configured builds may be called FarmSlicer.
  - Forks that change functionality must use another name, but may say "based on FarmSlicer".
  - A hosted service may say it "runs FarmSlicer" but may not put the mark in its own name or domain.
  - The logo needs permission.
  - Nominative use (articles, compatibility statements) is always fine.
  - AGPL §7(e) explicitly lets a licensor decline trademark rights as an additional term. Reference the policy from `LICENSE`'s notice.
- **Make the brand separable:** the name and logo should be in one place a fork can replace (it mostly is: favicon, manifest, `Layout.tsx`). That keeps the policy fair and enforceable.
- **Use others' marks nominatively only.** The README and UI already say "Bambu", "Prusa", "Klipper", "OctoPrint" nominatively. Keep it that way, and add the "not affiliated with" line the upstream wasm notice uses.

## Market and comparables

The sources were gathered October 26, 2026. "Unverified" means the figure comes
from a third party, not the vendor's own page.

### Print-farm software (direct competitors)

| Product | Free | Paid | Education | Open source |
| --- | --- | --- | --- | --- |
| SimplyPrint ([pricing](https://simplyprint.io/pricing)) | 2 printers, 1 user | $5.99/mo (3) · $9.99 (5–10) · Print Farm $39.99 (10) · Enterprise $299 | School $40/mo or $480/yr (2 printers, 500 users); districts by quote ([schools](https://simplyprint.io/articles/best-3d-printing-software-for-schools.md)) | No |
| Printago ([pricing](https://www.printago.io/pricing), [docs](https://docs.printago.io/docs/settings/subscription-management)) | Unlimited printers, 1 concurrent "production slot" | $4 per extra slot per month ("2025 introductory") | Page exists, no price | No |
| AutoFarm3D / 3DQue ([pricing](https://www.3dque.com/pricing)) | 3 printers, 100 automation h/mo | Pro $40/mo (25 printers) · slots $30–40/mo each · legacy $29.99 per printer per month | — | No |
| Obico ([upgrade](https://www.obico.io/docs/user-guides/upgrade-to-pro/), [server](https://github.com/TheSpaghettiDetective/obico-server)) | 1 printer, 10 AI-hours | $6.99–8.99/mo, then about $2 per extra printer | — | **Yes, AGPL-3.0**, self-host free. The closest model to FarmSlicer's. |
| OctoEverywhere ([pricing](https://octoeverywhere.com/pricing)) | 3 printers | About $3.99/mo (5), then about $1 per printer | — | No |
| 3DPrinterOS ([comparison](https://simplyprint.io/alternatives/3dprinteros)) | — | From about $19/mo (unverified) | Quote; about $200–250 per printer per year (unverified, a competitor's estimate) | No |
| Bambu Farm Manager ([All3DP](https://all3dp.com/4/bambu-labs-new-free-print-farm-software-streamlines-multi-printer-management/)) | **Free**: Windows, LAN, Bambu only (since May 2025) | — | — | No |
| Repetier-Server ([site](https://www.repetier-server.com/?p=691)) | 2 printers | Lite €29.99 one-off (5); Pro about €60 (unverified) | — | No |
| Polar Cloud ([reseller](https://shop3duniverse.com/collections/education-software/products/polar3d-online-software-for-3d-printing)) | — | Up to about $799/yr (unverified) | Education-focused | No |
| Prusa Connect ([All3DP](https://all3dp.com/6/prusa-connect-power-users-can-buy-more-usage-now/)) | Free for Prusa owners | $8.99 / $29.99 per month (2026); "Farm mode" announced | — | No |

What this says:

- A 10-printer farm pays about **$36–40/mo** today, roughly **$3–4 per printer per month**.
- Schools pay about **$130–250 per printer per year**, mostly through quotes and purchase orders, not card checkout.
- Bambu now gives away a LAN farm manager, so "Bambu-only plus local" is not something people pay for.
- FarmSlicer's differences:
  - it is the only **multi-vendor, self-hostable, open** option with a **real slicer built in** (server *and* in-browser);
  - it has groups, quotas and projects built for shared spaces;
  - nothing depends on a vendor cloud.
- The vendor's own survey (SimplyPrint, [2026](https://simplyprint.io/print-farm-survey); no sample size, so discount it) reports farms saving 10–15 hours a week and judging the software worth more than they pay.
- No candid community data on what farms pay was found.

### Open-source business models

- **Plausible** (AGPL; MIT until 2020): hosted-only revenue, 12k+ subscribers, no investors.
  - In 2024 it renamed self-hosting "Community Edition", held some features back, added a CLA and registered trademarks.
  - It said donations from self-hosters came to about $300/mo.
  - [Blog](https://plausible.io/blog/community-edition); critique: [werd.io](https://werd.io/introducing-plausible-community-edition/).
- **Cal.com:** AGPL core plus a commercially licensed `/ee` directory, i.e. open core. [Blog](https://next.cal.com/blog/changing-to-agplv3-and-introducing-enterprise-edition)
- **Ghost:** a non-profit foundation. About $11.2M ARR from about 30.5k customers on Ghost(Pro), at $15 / $29 / $199 per month. [About](https://ghost.org/about/), [pricing thread](https://forum.ghost.org/t/updated-ghost-pro-pricing-july-2025-15-mo-starter-29-mo-publisher-199-mo-business/59090)
- **Discourse:** GPL. Hosting $20 / $100 / $500 per month. [Pricing](https://www-redesign.discourse.org/pricing)
- **GitLab:** open core. Premium is $29 per user per month. [Capterra](https://www.capterra.com/p/159806/GitLab/pricing/)
- **Grafana:** Apache to AGPL in 2021. It chose AGPL over SSPL and sells a commercial licence as the alternative to AGPL. [Q&A](https://grafana.com/blog/2021/04/20/qa-with-our-ceo-on-relicensing/)
- **Elastic:** SSPL/ELv2 in 2021, AWS forked it as OpenSearch, AGPL re-added in 2024. [InfoQ](https://www.infoq.com/news/2024/09/elastic-open-source-agpl)
- **Nextcloud:** AGPL, everything free. Enterprise subscriptions (about €71–205 per user per year, 100-user minimum) sell support and a maintained lifecycle, not features. [Pricing](https://nextcloud.com/pricing/)
- **Home Assistant / Nabu Casa:** Apache.
  - Revenue comes from the convenience cloud ($6.50/mo or $65/yr: remote access, voice) and own hardware (Green, now $199 after 2026 RAM price rises).
  - The brand and code sit in the non-profit Open Home Foundation.
  - [Pricing](https://www.nabucasa.com/pricing/), [Green price](https://www.nabucasa.com/news/2026-01-08-green-pricing-change/)
- **OctoPrint:** donations only after losing a corporate sponsor. Over $5.2k/mo from about 1.9k Patreon backers (2023), plus about 680 GitHub sponsors. This is with one of the largest user bases in hobby 3D printing. [Wikipedia](https://en.wikipedia.org/wiki/OctoPrint), [Sponsors](https://github.com/sponsors/foosel)
- **Mainsail / Fluidd:** donations; no figures found.

### Hardware appliances

| Appliance | Price |
| --- | --- |
| Home Assistant Green | $199 |
| Start9 Server One | about $563 ([compare](https://start9.com/latest/umbrel-compare)) |
| Umbrel Home | $699 at its 2023 launch |
| OctoPrint Raspberry Pi bundles | about $80–120 ([Solarbotics](https://solarbotics.com/?p=88701)) |

The pattern is a plug-in box at roughly hardware cost plus $50–150, with the
margin on the subscription.

### Who pays for what, in this niche

| Customer | Buys | Pays for |
| --- | --- | --- |
| Small farms and Etsy sellers | By card, monthly | Saved hours: queueing, auto-dispatch, failure handling, mixed fleets. Price-sensitive, per printer. |
| Makerspaces | Annually, often on a volunteer budget | Accounts, quotas, approvals and a "just works" install. They often lack anyone to run a server. |
| Schools and student robotics leagues | Purchase orders and quotes, annual or multi-year, site licences rather than seats | Student data staying on site; no per-student accounts on a vendor cloud. Value low maintenance and a vendor they can phone. |

### What the code would need for multi-tenant hosting (flagged, not designed)

- **One install per farm.** It has one SQLite database, one `data/` directory and site-wide settings. One VAPID key per install. The passkey RP ID is the first origin's host.
- **Printers are reached from the server over the LAN:**
  - Bambu MQTT/FTPS;
  - Moonraker/OctoPrint/PrusaLink HTTP or WebSocket;
  - SDCP;
  - SSDP/mDNS discovery.

  **A cloud instance cannot reach a farm's printers** without an on-site agent or an outbound tunnel. This is the largest gap for SaaS.
- **One server slice at a time per process** (slicer mutex). Heavy CPU per tenant: browser slicing helps hosting costs.
- **No billing, no tenant provisioning, no tenant-level backup or restore.** No email, which is fine for passkeys but limits account recovery support.
- **Simplest route:** one container per customer ("single-tenant hosted") on a subdomain, plus the on-site agent. That needs no multi-tenancy in the app.

### Platform risk

- Bambu's January 2025 "Authorization Control" firmware put third-party LAN control behind Developer Mode, which is LAN-only and disables Bambu Cloud features ([Bambu blog](https://blog.bambulab.com/updates-and-third-party-integration-with-bambu-connect), [Bambu wiki](https://wiki.bambulab.com/en/software/third-party-integration), [All3DP](https://all3dp.com/4/bambu-lab-limits-third-party-printer-control-with-new-security-update/)).
- A commercial product whose biggest printer family depends on a vendor's goodwill should be multi-vendor in its pitch, as FarmSlicer already is.
- The docs should say exactly which printer modes customers must enable.

## Recommendation

1. **Fix compliance before the demo goes public.** All of this is small:
   - A "Source code" link (the exact commit, configurable base URL) in the sidebar footer and the What's New dialog.
   - A `/licenses` page and `THIRD_PARTY_NOTICES` in the image (`cargo about`, a Vite licence plugin, a C++ list from the table above, OFL.txt, OpenSSL/FreeType credits).
   - `license = "AGPL-3.0-or-later"` in `Cargo.toml` and `"license"` in `web/package.json`.
   - A notice block in `README`/`LICENSE`: "FarmSlicer's own code: AGPL-3.0-or-later. Builds that include libslic3r: AGPL-3.0."
   - SPDX headers on new files.
   - Move the deps build off OpenSSL 1.1.1 (gap 3).
   - Annotate or drop `wasm/NOTICE.orcaslicer-wasm.md`, and credit both orcaslicer-wasm repositories.
   - Decide on `hms.json` (gap 7).
   - A per-release source bundle with dep tarballs.
2. **Protect the name:**
   - USPTO search, then file "FarmSlicer" in classes 9 and 42 (about $700).
   - `TRADEMARKS.md` (Mozilla-style).
   - Use **DCO** (`Signed-off-by`), not a CLA. libslic3r pins the product to AGPL forever, so a CLA's main benefit (relicensing) isn't available, and a CLA puts off contributors. Revisit only if the drivers are ever split into a separately licensed library.
3. **Sell first: a managed on-site box plus a care plan,** aimed at makerspaces and schools.
   - Why it fits:
     - it runs on the farm's LAN, so it needs none of the multi-tenant or agent work;
     - it keeps student data on site;
     - it sells the thing those customers can't do themselves (run a server).
   - The box: a fanless N100-class mini-PC, preinstalled and preconfigured. Price **about $349–449**, which is hardware plus setup margin.
   - The care plan: updates, encrypted off-site backups, remote access through FarmSlicer's existing passkey-only remote mode, and email support.
     - **$15/mo, or $150/yr, up to 10 printers**;
     - then about **$1.50 per printer per month**;
     - **school or space site licence $300–600/yr**, invoiced, on a purchase order.
   - This is deliberately at or below SimplyPrint/Printago for a farm, and well below education quotes.
   - An **install service on the customer's own hardware** at a flat **$200–400** is the same offer without the hardware risk. Start with it to learn the setup pain.
4. **Second: support contracts and paid driver work.**
   - Annual support with response-time tiers, about **$500–2,500/yr**.
   - "Add my printer model" bounties or fixed bids, with the work landing upstream.
5. **Third, and only after an on-site agent exists: hosted FarmSlicer.**
   - Single-tenant containers per customer, priced like the market (about **$3–4 per printer per month**, $9–15/mo minimum).
   - Lean on browser slicing to keep hosting cheap.
   - Until the agent exists, a hosted version can only offer slicing, the library, projects and upload, not printer control. That is a weak product against free desktop slicers.
6. **Ongoing:**
   - GitHub Sponsors and Open Collective for goodwill. Expect tens to low hundreds of dollars a month (Plausible: about $300/mo; OctoPrint is the exception, not the rule).
   - A "Works with FarmSlicer" programme later, if printer vendors become interested.

### Risks

| Risk | What it means |
| --- | --- |
| Free competitors and forks | Anyone can host FarmSlicer or sell boxes running it. The trademark, being the upstream, and support quality are the only defences. The licence doesn't help. |
| Vendor protocol changes | Bambu has already restricted third-party access once. A firmware change can break the core feature for the biggest customer segment overnight. |
| Hardware business overhead | Inventory, shipping, returns, warranty, and sales tax across states. Keep the box optional, and lead with installs on customers' hardware. |
| School procurement | Slow: purchase orders, W-9s, vendor registration, student-data agreements under FERPA, COPPA and state laws. On-site data helps, but the paperwork is real. |
| Copyright and compliance hygiene | The AI-assisted code's thin copyright, the OpenSSL 1.1.1 licence clash, and the unlicensed HMS data are each small. Together they matter only to someone looking for leverage. Fix the cheap ones now. |
| Bus factor | One maintainer selling support contracts is a promise one person must keep. Price support so it can be refused or capped. |

## Open questions for the maintainer

1. **License notice:** keep "AGPL-3.0-or-later" for FarmSlicer's own code and state that builds are AGPL-3.0, or simplify everything to AGPL-3.0-only? *Recommendation: keep or-later for own code, and add the two-line explanation.*
2. **Contributions:** DCO or CLA? *Recommendation: DCO (see Recommendation 2).*
3. **First offering:** managed box, install service, or both? *Recommendation: install service first (no inventory), and the box once three or four installs show what it needs.*
4. **Trademark:** file now, in the maintainer's name or a company's? A company (LLC) to hold the mark, sign support contracts and sell hardware is worth deciding before the first sale.
5. **HMS data:** fetch it at run time, ask Bambu, or keep shipping it with attribution? *Recommendation: fetch at run time with the bundled copy as a fallback, attributed.*
6. **Hosted demo:** should it be a fully open instance (fake printers only, reset nightly, uploads and slice time capped), or sign-in only?
7. **OpenSSL in the deps build:** upgrade the deps' OpenSSL to 3.x, or prove curl and OpenSSL aren't needed by headless libslic3r and drop them? This is a build-side task for a separate thread.
