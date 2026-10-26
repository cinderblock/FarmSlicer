# FarmSlicer's icon

An F drawn in extrusion beads, the way a slicer lays down a part: its arms
are long beads and its stem short ones, white on the app's accent blue
(`--accent`, #4a9eff, shading to #2a5fb8).

- `icon.svg`: rounded square. It is `favicon.svg` as-is, and the source of
  the "any" icons.
- `full-bleed.svg`: square, with the F shrunk to 80% to stay inside the
  maskable safe zone (the centre circle of radius 40%). It is the source of
  the Android maskable icon and of iOS's `apple-touch-icon` (iOS rounds
  the corners itself).
- `badge.svg`: the F alone on transparent, for the notification badge
  (`badge-96.png`; Android draws it as a white silhouette).
- `render.sh` writes every PNG in `web/public` (needs `resvg`). Run it after
  changing either SVG and commit the results.
