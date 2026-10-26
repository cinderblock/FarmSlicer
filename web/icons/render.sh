#!/usr/bin/env bash
# Render FarmSlicer's icons into web/public from the SVGs here. Needs resvg
# (`cargo install resvg`); run after changing icon.svg or full-bleed.svg and
# commit the results (the build doesn't render them).
set -euo pipefail
cd "$(dirname "$0")"
out=../public
cp icon.svg "$out/favicon.svg"
resvg -w 32 -h 32 icon.svg "$out/favicon-32.png"
# "any" icons keep the rounded corners; launchers that mask (Android) and
# iOS (which rounds its own corners) get the full-bleed square.
resvg -w 192 -h 192 icon.svg "$out/icon-192.png"
resvg -w 512 -h 512 icon.svg "$out/icon-512.png"
resvg -w 512 -h 512 full-bleed.svg "$out/icon-maskable-512.png"
resvg -w 180 -h 180 full-bleed.svg "$out/apple-touch-icon.png"
# Notification badge (Android shows its alpha as a white silhouette).
resvg -w 96 -h 96 badge.svg "$out/badge-96.png"
