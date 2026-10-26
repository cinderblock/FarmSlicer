# Notice: orcaslicer-wasm's licence

The build-system pieces under `wasm/` (CMake find-modules, sequential-TBB
shims, the libslic3r patch, toolchain scripts) are adapted from
[JoshTheDerf/orcaslicer-wasm](https://github.com/JoshTheDerf/orcaslicer-wasm)
by Joshua Bemenderfer, which is a fork of
[allanwrench28/orcaslicer-wasm](https://github.com/allanwrench28/orcaslicer-wasm)
by Allan Wrench (WrenchWorks3D). Both are WebAssembly ports of OrcaSlicer.

Both repositories carry the same `LICENSE`, copied here unchanged as
`LICENSE.orcaslicer-wasm`: the GNU Affero General Public License, version 3
"or (at your option) any later version", with the copyright lines of the port
and of OrcaSlicer, Bambu Studio, PrusaSlicer and Slic3r. It was added
upstream on 2025-10-27 (commit `4fedac2`, "Add comprehensive LICENSE file
with proper attribution").

Both repositories also still have an older `NOTICE.md`, written before that
licence existed:

> This project will interface with OrcaSlicer. Licensing will be added later.
> Until a LICENSE file is added, all rights reserved.

By its own wording that notice ended when the `LICENSE` file was added, and the
port is a derivative of OrcaSlicer (AGPL-3.0) in any case. It is quoted here
only so the history is clear; it places no restriction on this code.

FarmSlicer uses these pieces under the AGPL-3.0, and the browser engine built
from them is AGPL-3.0 as a whole (see `LICENSE.txt` and `../NOTICE`).
