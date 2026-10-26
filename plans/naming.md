# Naming: keep "FarmSlicer" or rename before the app icon

`plans/naming.md`

## Goal

Before the app gets a real icon (it is about to land on people's home
screens), decide whether "FarmSlicer" is the name to keep. The maintainer's
concern (2026-10-26): weak search-engine prospects, though no clear conflict.

## Decisions already made (don't re-ask)

- **Keep the name FarmSlicer** (maintainer, 2026-10-26).
- **Icon: the layer "F"** (concept C: an F drawn in extrusion beads on the
  accent blue). Sources in `web/icons/`.

## Findings (2026-10-26)

How names were checked: web search (3D printing, software, products),
GitHub repository names (`gh api search/repositories`), `.com` registration
at the registry (Verisign RDAP: 404 = unregistered), `.io`/`.app`/`.dev` by
DNS NS records (a proxy: registered-but-parked domains can lack NS). **No
trademark search yet** (USPTO/EUIPO); do one before committing to a name.

- **FarmSlicer**: no product, company or other repo uses it; `farmslicer.com`
  is unregistered, as are the `.io`/`.app`/`.dev` names. As one word it is a
  unique token. The weakness: "farm slicer" with a space is two generic words,
  and searches for it return Printago's "print farm slicing" pages and
  kitchen/meat slicers. The neighbours have distinctive names (OctoFarm,
  FDM Monster, SimplyPrint, Printago, AutoFarm3D, Printerhive).
- **Free on every check** (no repo, no product found, `.com` unregistered):
  Sliceyard, Layeracre, Slicefleet, Gantryfarm (but "gantry farming" is
  a real agricultural term), Layergrange, Printgrange (one empty repo),
  Bedyard, Fieldslice.
- **Out**:
  - Printhive and Layerhive: Printerhive (printerhive.com) is an existing
    print-farm product.
  - Printyard and Printstead: every domain is taken.
  - Spoolhouse: a Thingiverse project, `.com` taken.
  - Spoolyard: an active open-source piping tool.
  - Layerline: every domain is taken.
  - Farmforge: 21 repos, `.com` taken.
  - Dictionary words (Furrow, Swath, Sheaf, Hayloft, Steading, Croft,
    Granary, Tilth, Harrow): every domain is taken, hundreds of repos, and
    hard to rank for.
  - Printacre: `.com` registered.
  - Layerfarm, Plateyard, Layerloft, Platebarn: `.com` registered.

## What a rename touches

654 mentions in 151 files. Outward-facing ones need care:

- Webhook headers (`X-FarmSlicer-*`): a published contract.
- Environment variables (`FARMSLICER_*`): the ops stack sets
  `FARMSLICER_ORIGINS` and `FARMSLICER_LAN_HEADER`.
- localStorage keys (`farmslicer.*`): users' drafts and settings.
- The GHCR image name, and the GitHub repo name (GitHub redirects renames).

The deployment's domain is separate from the product name, so passkeys
(RP ID = the site's host) survive a rename.

## Open questions for the user

(none)

## Progress log

- [x] Conflict and domain checks for ~40 candidates
- [x] Name decided: FarmSlicer stays
- [x] Icon: the layer "F", `web/icons/` + `render.sh`
- [ ] Trademark search on "FarmSlicer" (not done)
