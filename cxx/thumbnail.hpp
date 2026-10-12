// Software rendering of plate thumbnails (no OpenGL: the server is headless
// and the WebAssembly engine has no GL context), plus an optional label and
// logo drawn on top. Shared by both engines like slice_core.
#pragma once

#include <string>
#include <vector>

namespace Slic3r {
class Model;
struct ThumbnailData;
}

namespace farmslicer::core {

struct ThumbnailOverlay {
    /// Text for a badge in the bottom-right corner (e.g. a team number).
    std::string label;
    /// Logo drawn in the top-left corner: RGBA, straight alpha, rows
    /// top-down, `logo_width` x `logo_height`. The callers decode the image
    /// (Rust on the server, the browser for the WebAssembly engine).
    std::vector<unsigned char> logo_rgba;
    unsigned logo_width = 0;
    unsigned logo_height = 0;
    /// TrueType font for the label.
    std::string font_path;

    bool empty() const { return label.empty() && logo_rgba.empty(); }
};

/// Render the printable instances of an already placed `model` into `out`:
/// RGBA, transparent background, rows bottom-up (how libslic3r stores
/// thumbnails), an isometric view from the front right, each part in its
/// filament's colour (`extruder_colors`, "#RRGGBB" per filament).
void render_thumbnail(const Slic3r::Model& model,
                      const std::vector<std::string>& extruder_colors,
                      unsigned width,
                      unsigned height,
                      Slic3r::ThumbnailData& out);

/// Draw `overlay` onto `image`. Returns problems (bad logo size, missing
/// font) as warnings; the image is still usable.
std::vector<std::string> apply_overlay(Slic3r::ThumbnailData& image, const ThumbnailOverlay& overlay);

} // namespace farmslicer::core
