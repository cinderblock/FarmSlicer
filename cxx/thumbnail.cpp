// Plate thumbnails without a GPU: a small z-buffer rasteriser over the placed
// model's triangles, supersampled for smooth edges, and an overlay (label
// badge via stb_truetype, logo from RGBA pixels the caller decoded).

#include "thumbnail.hpp"

#include <libslic3r/libslic3r.h>
#include <libslic3r/Model.hpp>
#include <libslic3r/GCode/ThumbnailData.hpp>

// The implementation is compiled into libslic3r (Emboss.cpp).
#include "imgui/imstb_truetype.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <fstream>
#include <iterator>
#include <limits>

namespace farmslicer::core {

namespace {

using Vec3 = Eigen::Vector3d;

struct Rgb {
    double r, g, b;
};

Rgb parse_color(const std::string& hex, Rgb fallback)
{
    std::string h = hex;
    if (!h.empty() && h[0] == '#') h.erase(0, 1);
    if (h.size() < 6) return fallback;
    try {
        const unsigned long v = std::stoul(h.substr(0, 6), nullptr, 16);
        return {((v >> 16) & 0xFF) / 255.0, ((v >> 8) & 0xFF) / 255.0, (v & 0xFF) / 255.0};
    } catch (...) {
        return fallback;
    }
}

// Linear ↔ sRGB, so shading looks right.
double to_linear(double c) { return c <= 0.04045 ? c / 12.92 : std::pow((c + 0.055) / 1.055, 2.4); }
double to_srgb(double c)
{
    c = std::clamp(c, 0.0, 1.0);
    return c <= 0.0031308 ? c * 12.92 : 1.055 * std::pow(c, 1.0 / 2.4) - 0.055;
}

struct Tri {
    Vec3 a, b, c;
    Rgb color; // linear
};

int volume_extruder(const Slic3r::ModelObject& obj, const Slic3r::ModelVolume& vol)
{
    int e = vol.extruder_id();
    if (e <= 0) {
        if (const Slic3r::ConfigOption* opt = obj.config.option("extruder")) e = opt->getInt();
    }
    return std::max(e, 1);
}

std::vector<Tri> collect(const Slic3r::Model& model, const std::vector<std::string>& colors)
{
    const Rgb fallback{0.0, 0.682, 0.259}; // Bambu green
    std::vector<Tri> tris;
    for (const Slic3r::ModelObject* obj : model.objects) {
        for (const Slic3r::ModelInstance* inst : obj->instances) {
            if (!inst->printable) continue;
            for (const Slic3r::ModelVolume* vol : obj->volumes) {
                if (!vol->is_model_part()) continue;
                const int e = volume_extruder(*obj, *vol);
                Rgb c = size_t(e) <= colors.size() ? parse_color(colors[e - 1], fallback) : fallback;
                c = {to_linear(c.r), to_linear(c.g), to_linear(c.b)};
                const Slic3r::Transform3d m = inst->get_matrix() * vol->get_matrix();
                const indexed_triangle_set& its = vol->mesh().its;
                tris.reserve(tris.size() + its.indices.size());
                for (const auto& f : its.indices) {
                    tris.push_back({m * its.vertices[f[0]].cast<double>(),
                                    m * its.vertices[f[1]].cast<double>(),
                                    m * its.vertices[f[2]].cast<double>(), c});
                }
            }
        }
    }
    return tris;
}

// Pixel access with rows top-down (images are stored bottom-up).
struct Canvas {
    Slic3r::ThumbnailData& img;
    unsigned char* at(int x, int y) { return &img.pixels[(size_t(img.height - 1 - y) * img.width + x) * 4]; }
    bool inside(int x, int y) const { return x >= 0 && y >= 0 && x < int(img.width) && y < int(img.height); }

    /// Source-over compositing of a straight-alpha colour.
    void blend(int x, int y, double r, double g, double b, double a)
    {
        if (!inside(x, y) || a <= 0) return;
        unsigned char* p = at(x, y);
        const double da = p[3] / 255.0;
        const double oa = a + da * (1 - a);
        if (oa <= 0) return;
        auto mix = [&](double s, unsigned char d) {
            return (unsigned char)std::lround(std::clamp((s * a + d / 255.0 * da * (1 - a)) / oa, 0.0, 1.0) * 255);
        };
        p[0] = mix(r, p[0]);
        p[1] = mix(g, p[1]);
        p[2] = mix(b, p[2]);
        p[3] = (unsigned char)std::lround(oa * 255);
    }
};

std::vector<unsigned char> read_file(const std::string& path)
{
    std::ifstream f(path, std::ios::binary);
    return std::vector<unsigned char>((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
}

/// UTF-8 → code points (invalid bytes become U+FFFD).
std::vector<int> codepoints(const std::string& s)
{
    std::vector<int> out;
    for (size_t i = 0; i < s.size();) {
        const unsigned char c = s[i];
        int cp = 0xFFFD, len = 1;
        if (c < 0x80) cp = c;
        else if ((c >> 5) == 0x6 && i + 1 < s.size()) cp = ((c & 0x1F) << 6) | (s[i + 1] & 0x3F), len = 2;
        else if ((c >> 4) == 0xE && i + 2 < s.size())
            cp = ((c & 0x0F) << 12) | ((s[i + 1] & 0x3F) << 6) | (s[i + 2] & 0x3F), len = 3;
        else if ((c >> 3) == 0x1E && i + 3 < s.size())
            cp = ((c & 0x07) << 18) | ((s[i + 1] & 0x3F) << 12) | ((s[i + 2] & 0x3F) << 6) | (s[i + 3] & 0x3F), len = 4;
        out.push_back(cp);
        i += len;
    }
    return out;
}

void rounded_rect(Canvas& cv, double x0, double y0, double x1, double y1, double radius, Rgb c, double alpha)
{
    for (int y = int(std::floor(y0)); y < int(std::ceil(y1)); ++y) {
        for (int x = int(std::floor(x0)); x < int(std::ceil(x1)); ++x) {
            // Coverage by 4x4 subsamples: smooth corners.
            int hit = 0;
            for (int sy = 0; sy < 4; ++sy)
                for (int sx = 0; sx < 4; ++sx) {
                    const double px = x + (sx + 0.5) / 4, py = y + (sy + 0.5) / 4;
                    if (px < x0 || px > x1 || py < y0 || py > y1) continue;
                    const double cx = std::clamp(px, x0 + radius, x1 - radius);
                    const double cy = std::clamp(py, y0 + radius, y1 - radius);
                    if ((px - cx) * (px - cx) + (py - cy) * (py - cy) <= radius * radius) ++hit;
                }
            if (hit) cv.blend(x, y, c.r, c.g, c.b, alpha * hit / 16.0);
        }
    }
}

bool draw_label(Canvas& cv, const std::string& label, const std::string& font_path, std::vector<std::string>& warnings)
{
    const std::vector<unsigned char> font = read_file(font_path);
    stbtt_fontinfo info;
    if (font.empty() || !stbtt_InitFont(&info, font.data(), stbtt_GetFontOffsetForIndex(font.data(), 0))) {
        warnings.push_back("thumbnail label: can't load the font " + font_path);
        return false;
    }
    const std::vector<int> text = codepoints(label);
    const double W = cv.img.width, H = cv.img.height;
    const double margin = std::round(W * 0.03);

    // Size the text to ~16% of the height, smaller if it would be too wide.
    double px = H * 0.16;
    auto measure = [&](double size) {
        const float scale = stbtt_ScaleForPixelHeight(&info, float(size));
        double w = 0;
        for (size_t i = 0; i < text.size(); ++i) {
            int adv, lsb;
            stbtt_GetCodepointHMetrics(&info, text[i], &adv, &lsb);
            w += adv * scale;
            if (i + 1 < text.size()) w += stbtt_GetCodepointKernAdvance(&info, text[i], text[i + 1]) * scale;
        }
        return w;
    };
    double text_w = measure(px);
    const double max_w = W - 2 * margin - px * 0.6;
    if (text_w > max_w) {
        px *= max_w / text_w;
        text_w = measure(px);
    }
    const float scale = stbtt_ScaleForPixelHeight(&info, float(px));
    int ascent, descent, line_gap;
    stbtt_GetFontVMetrics(&info, &ascent, &descent, &line_gap);
    const double text_h = (ascent - descent) * scale;

    const double pad_x = px * 0.3, pad_y = px * 0.12;
    const double x1 = W - margin, y1 = H - margin;
    const double x0 = x1 - text_w - 2 * pad_x, y0 = y1 - text_h - 2 * pad_y;
    rounded_rect(cv, x0, y0, x1, y1, px * 0.22, {0.07, 0.09, 0.15}, 0.86);

    double pen = x0 + pad_x;
    const int baseline = int(std::lround(y0 + pad_y + ascent * scale));
    for (size_t i = 0; i < text.size(); ++i) {
        int adv, lsb, bx0, by0, bx1, by1;
        stbtt_GetCodepointHMetrics(&info, text[i], &adv, &lsb);
        const float shift_x = float(pen - std::floor(pen));
        stbtt_GetCodepointBitmapBoxSubpixel(&info, text[i], scale, scale, shift_x, 0, &bx0, &by0, &bx1, &by1);
        const int gw = bx1 - bx0, gh = by1 - by0;
        if (gw > 0 && gh > 0) {
            std::vector<unsigned char> glyph(size_t(gw) * gh);
            stbtt_MakeCodepointBitmapSubpixel(&info, glyph.data(), gw, gh, gw, scale, scale, shift_x, 0, text[i]);
            for (int gy = 0; gy < gh; ++gy)
                for (int gx = 0; gx < gw; ++gx)
                    if (const unsigned char a = glyph[size_t(gy) * gw + gx])
                        cv.blend(int(std::floor(pen)) + bx0 + gx, baseline + by0 + gy, 1, 1, 1, a / 255.0);
        }
        pen += adv * scale;
        if (i + 1 < text.size()) pen += stbtt_GetCodepointKernAdvance(&info, text[i], text[i + 1]) * scale;
    }
    return true;
}

bool draw_logo(Canvas& cv, const ThumbnailOverlay& o, std::vector<std::string>& warnings)
{
    const size_t cols = o.logo_width, rows = o.logo_height;
    if (cols == 0 || rows == 0 || o.logo_rgba.size() != cols * rows * 4) {
        warnings.push_back("thumbnail logo: pixel data doesn't match its size");
        return false;
    }
    const double W = cv.img.width, H = cv.img.height;
    const double margin = std::round(W * 0.03);
    const double box = std::min(W, H) * 0.28;
    const double s = std::min(box / cols, box / rows);
    const int w = std::max(1, int(std::lround(cols * s))), h = std::max(1, int(std::lround(rows * s)));
    // Area-averaged downscale (or nearest when enlarging).
    for (int y = 0; y < h; ++y) {
        for (int x = 0; x < w; ++x) {
            const double sx0 = x / s, sx1 = (x + 1) / s, sy0 = y / s, sy1 = (y + 1) / s;
            double r = 0, g = 0, b = 0, a = 0, n = 0;
            for (size_t yy = size_t(sy0); yy < std::min(rows, size_t(std::ceil(sy1))); ++yy)
                for (size_t xx = size_t(sx0); xx < std::min(cols, size_t(std::ceil(sx1))); ++xx) {
                    const unsigned char* p = &o.logo_rgba[(yy * cols + xx) * 4];
                    const double pa = p[3] / 255.0;
                    r += p[0] / 255.0 * pa;
                    g += p[1] / 255.0 * pa;
                    b += p[2] / 255.0 * pa;
                    a += pa;
                    n += 1;
                }
            if (n == 0 || a <= 0) continue;
            cv.blend(int(margin) + x, int(margin) + y, r / a, g / a, b / a, a / n);
        }
    }
    return true;
}

} // namespace

void render_thumbnail(const Slic3r::Model& model,
                      const std::vector<std::string>& extruder_colors,
                      unsigned width,
                      unsigned height,
                      Slic3r::ThumbnailData& out)
{
    out.set(width, height);
    std::fill(out.pixels.begin(), out.pixels.end(), 0);
    const std::vector<Tri> tris = collect(model, extruder_colors);
    if (tris.empty() || width == 0 || height == 0) return;

    // Camera: looking from the front right, above.
    const Vec3 eye = Vec3(0.55, -1.0, 0.8).normalized();
    const Vec3 fwd = -eye;
    const Vec3 right = fwd.cross(Vec3::UnitZ()).normalized();
    const Vec3 up = right.cross(fwd);

    double xmin = std::numeric_limits<double>::max(), xmax = -xmin, ymin = xmin, ymax = -xmin;
    for (const Tri& t : tris)
        for (const Vec3* p : {&t.a, &t.b, &t.c}) {
            const double x = p->dot(right), y = p->dot(up);
            xmin = std::min(xmin, x), xmax = std::max(xmax, x), ymin = std::min(ymin, y), ymax = std::max(ymax, y);
        }

    constexpr int SS = 3; // supersampling per axis
    const int sw = int(width) * SS, sh = int(height) * SS;
    const double margin = 0.08;
    const double scale = std::min(sw * (1 - 2 * margin) / std::max(xmax - xmin, 1e-6),
                                  sh * (1 - 2 * margin) / std::max(ymax - ymin, 1e-6));
    const double cx = (xmin + xmax) / 2, cy = (ymin + ymax) / 2;

    std::vector<float> depth(size_t(sw) * sh, std::numeric_limits<float>::infinity());
    std::vector<std::array<float, 3>> color(size_t(sw) * sh);

    const Vec3 key = Vec3(0.35, -0.55, 1.0).normalized();
    const Vec3 fill = Vec3(-0.9, -0.3, 0.35).normalized();

    for (const Tri& t : tris) {
        Vec3 n = (t.b - t.a).cross(t.c - t.a);
        const double len = n.norm();
        if (len <= 0) continue;
        n /= len;
        if (n.dot(eye) < 0) n = -n; // two-sided: meshes aren't always consistently oriented
        const double light = 0.22 + 0.68 * std::max(0.0, n.dot(key)) + 0.22 * std::max(0.0, n.dot(fill));
        const std::array<float, 3> shade{float(t.color.r * light), float(t.color.g * light), float(t.color.b * light)};

        double px[3], py[3], pz[3];
        const Vec3* v[3] = {&t.a, &t.b, &t.c};
        for (int i = 0; i < 3; ++i) {
            px[i] = (v[i]->dot(right) - cx) * scale + sw / 2.0;
            py[i] = sh / 2.0 - (v[i]->dot(up) - cy) * scale;
            pz[i] = v[i]->dot(fwd);
        }
        const double area = (px[1] - px[0]) * (py[2] - py[0]) - (px[2] - px[0]) * (py[1] - py[0]);
        if (std::abs(area) < 1e-12) continue;
        const int x0 = std::max(0, int(std::floor(std::min({px[0], px[1], px[2]}))));
        const int x1 = std::min(sw - 1, int(std::ceil(std::max({px[0], px[1], px[2]}))));
        const int y0 = std::max(0, int(std::floor(std::min({py[0], py[1], py[2]}))));
        const int y1 = std::min(sh - 1, int(std::ceil(std::max({py[0], py[1], py[2]}))));
        for (int y = y0; y <= y1; ++y) {
            const double sy = y + 0.5;
            for (int x = x0; x <= x1; ++x) {
                const double sx = x + 0.5;
                const double w0 = ((px[1] - sx) * (py[2] - sy) - (px[2] - sx) * (py[1] - sy)) / area;
                const double w1 = ((px[2] - sx) * (py[0] - sy) - (px[0] - sx) * (py[2] - sy)) / area;
                const double w2 = 1 - w0 - w1;
                if (w0 < 0 || w1 < 0 || w2 < 0) continue;
                const float z = float(w0 * pz[0] + w1 * pz[1] + w2 * pz[2]);
                const size_t i = size_t(y) * sw + x;
                if (z < depth[i]) {
                    depth[i] = z;
                    color[i] = shade;
                }
            }
        }
    }

    // Box-filter the subsamples into straight-alpha sRGB pixels.
    Canvas cv{out};
    for (int y = 0; y < int(height); ++y) {
        for (int x = 0; x < int(width); ++x) {
            double r = 0, g = 0, b = 0;
            int hit = 0;
            for (int sy = 0; sy < SS; ++sy)
                for (int sx = 0; sx < SS; ++sx) {
                    const size_t i = size_t(y * SS + sy) * sw + (x * SS + sx);
                    if (std::isinf(depth[i])) continue;
                    r += color[i][0], g += color[i][1], b += color[i][2];
                    ++hit;
                }
            if (!hit) continue;
            unsigned char* p = cv.at(x, y);
            p[0] = (unsigned char)std::lround(to_srgb(r / hit) * 255);
            p[1] = (unsigned char)std::lround(to_srgb(g / hit) * 255);
            p[2] = (unsigned char)std::lround(to_srgb(b / hit) * 255);
            p[3] = (unsigned char)std::lround(255.0 * hit / (SS * SS));
        }
    }
}

std::vector<std::string> apply_overlay(Slic3r::ThumbnailData& image, const ThumbnailOverlay& overlay)
{
    std::vector<std::string> warnings;
    if (!image.is_valid()) return warnings;
    Canvas cv{image};
    if (!overlay.logo_rgba.empty()) draw_logo(cv, overlay, warnings);
    if (!overlay.label.empty()) draw_label(cv, overlay.label, overlay.font_path, warnings);
    return warnings;
}

} // namespace farmslicer::core
