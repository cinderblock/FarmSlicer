//! Reading plain G-code: what the slicer wrote about it in comments, and the
//! thumbnails embedded in it.
//!
//! OrcaSlicer (and PrusaSlicer, which it follows) writes, for printers other
//! than Bambu's:
//! - at the top, the thumbnails the printer profile asks for, as base64
//!   between `; thumbnail begin 300x300 12345` and `; thumbnail end`
//!   (`thumbnail_JPG`, `thumbnail_QOI` for other formats);
//! - at the bottom, `; filament used [g] = 1.23, 0.00`,
//!   `; total filament used [g] = 1.23`,
//!   `; estimated printing time (normal mode) = 1h 2m 3s`, then the whole
//!   config as `; key = value` lines (`printer_model`, `nozzle_diameter`,
//!   `filament_type` = `PLA;PETG`, `filament_colour`, `curr_bed_type`, ...).
//!
//! Cura writes `;TIME:<seconds>`. Files from other slicers just tell us less.

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use base64::Engine;
use md5::{Digest, Md5};

use super::{FilamentUse, Image, Package, PackageFormat, Plate};

/// The thumbnails sit in the first lines; large PNGs run to a few hundred kB.
const HEAD_BYTES: usize = 4 << 20;
/// The stats and the config block sit in the last lines.
const TAIL_BYTES: u64 = 2 << 20;

/// Read a G-code file: its first and last bytes as text, and the MD5 of the
/// whole file.
fn read_ends(path: &Path) -> Result<(String, String, String), String> {
    let mut file = std::fs::File::open(path).map_err(|e| format!("can't open the file: {e}"))?;
    let mut hasher = Md5::new();
    let mut head = Vec::new();
    let mut buf = vec![0u8; 1 << 16];
    let mut total: u64 = 0;
    loop {
        let n = file.read(&mut buf).map_err(|e| format!("can't read the file: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        if head.len() < HEAD_BYTES {
            let take = n.min(HEAD_BYTES - head.len());
            head.extend_from_slice(&buf[..take]);
        }
        total += n as u64;
    }
    let tail = if total <= HEAD_BYTES as u64 {
        Vec::new()
    } else {
        let start = total.saturating_sub(TAIL_BYTES).max(HEAD_BYTES as u64);
        file.seek(SeekFrom::Start(start)).map_err(|e| format!("can't read the file: {e}"))?;
        let mut tail = Vec::new();
        file.read_to_end(&mut tail).map_err(|e| format!("can't read the file: {e}"))?;
        tail
    };
    Ok((
        String::from_utf8_lossy(&head).into_owned(),
        String::from_utf8_lossy(&tail).into_owned(),
        hex::encode_upper(hasher.finalize()),
    ))
}

/// Does this start like G-code (commands, or a slicer's comments)?
fn check_gcode(head: &str) -> Result<(), String> {
    if head.starts_with("GCDE") {
        return Err("binary G-code (.bgcode) isn't supported; export plain .gcode".to_string());
    }
    let commands = head
        .lines()
        .take(5000)
        .map(str::trim_start)
        .any(|l| {
            let mut c = l.chars();
            matches!(c.next(), Some('G' | 'M' | 'T' | 'g' | 'm')) && c.next().is_some_and(|d| d.is_ascii_digit())
        });
    if commands {
        Ok(())
    } else {
        Err("this doesn't look like G-code (or a .gcode.3mf sliced project)".to_string())
    }
}

/// `; key = value` (and OrcaSlicer's header style, `; key: value`)
/// comments, later ones winning (the config block at the end is the
/// authority).
fn comments<'a>(texts: &[&'a str]) -> HashMap<&'a str, &'a str> {
    let mut map = HashMap::new();
    for text in texts {
        for line in text.lines() {
            let Some(rest) = line.strip_prefix(';') else { continue };
            if let Some((key, value)) = rest.split_once(" = ").or_else(|| rest.split_once(": ")) {
                map.insert(key.trim(), value.trim());
            }
        }
    }
    map
}

/// "1d 2h 3m 4s" (any part may be missing) → seconds.
fn parse_dhms(text: &str) -> Option<f64> {
    let mut secs = 0.0;
    let mut any = false;
    for part in text.split_whitespace() {
        let (number, unit) = part.split_at(part.find(|c: char| c.is_ascii_alphabetic())?);
        let n: f64 = number.parse().ok()?;
        secs += n * match unit {
            "d" => 86400.0,
            "h" => 3600.0,
            "m" => 60.0,
            "s" => 1.0,
            _ => return None,
        };
        any = true;
    }
    any.then_some(secs)
}

fn print_time(c: &HashMap<&str, &str>, texts: &[&str]) -> Option<f64> {
    if let Some(t) = c.get("estimated printing time (normal mode)").and_then(|t| parse_dhms(t)) {
        return Some(t);
    }
    for text in texts {
        for line in text.lines() {
            // Cura.
            if let Some(t) = line.strip_prefix(";TIME:") {
                return t.trim().parse().ok();
            }
            // OrcaSlicer's Bambu-style header.
            if let Some(rest) = line.strip_prefix("; model printing time:") {
                if let Some((_, total)) = rest.split_once("total estimated time:") {
                    return parse_dhms(total.trim());
                }
            }
        }
    }
    None
}

fn list<'a>(c: &HashMap<&str, &'a str>, key: &str, sep: char) -> Vec<&'a str> {
    c.get(key)
        .map(|v| v.split(sep).map(|s| s.trim().trim_matches('"')).collect())
        .unwrap_or_default()
}

fn numbers(c: &HashMap<&str, &str>, key: &str) -> Vec<f64> {
    list(c, key, ',').iter().map(|n| n.parse().unwrap_or(0.0)).collect()
}

/// The filaments the print uses, numbered like the slicer's extruders.
fn filaments(c: &HashMap<&str, &str>) -> Vec<FilamentUse> {
    let types = list(c, "filament_type", ';');
    let colors = list(c, "filament_colour", ';');
    let grams = numbers(c, "filament used [g]");
    let mm = numbers(c, "filament used [mm]");
    // OrcaSlicer's header names the filaments used ("; filament: 1,3").
    let used_ids: Vec<u32> = c
        .get("filament")
        .map(|v| v.split(',').filter_map(|n| n.trim().parse().ok()).collect())
        .unwrap_or_default();
    let count = types.len().max(grams.len());
    (0..count)
        .filter(|&i| {
            let id = i as u32 + 1;
            match grams.get(i) {
                Some(&g) => g > 0.0,
                None if !used_ids.is_empty() => used_ids.contains(&id),
                None => i == 0,
            }
        })
        .map(|i| FilamentUse {
            id: i as u32 + 1,
            material: types.get(i).copied().unwrap_or("").to_string(),
            color: colors.get(i).copied().unwrap_or("").to_string(),
            filament_id: String::new(),
            used_g: grams.get(i).copied().unwrap_or(0.0),
            used_m: mm.get(i).copied().unwrap_or(0.0) / 1000.0,
        })
        .collect()
}

/// A thumbnail embedded in G-code.
#[derive(Debug, Clone, PartialEq)]
pub struct Thumbnail {
    pub width: u32,
    pub height: u32,
    /// "PNG", "JPG" or "QOI".
    pub format: String,
    pub data: Vec<u8>,
}

/// Every thumbnail block in `text`.
pub fn thumbnails(text: &str) -> Vec<Thumbnail> {
    let mut out = Vec::new();
    let mut current: Option<(u32, u32, String, String)> = None;
    for line in text.lines() {
        let Some(body) = line.strip_prefix(';').map(str::trim) else {
            // Thumbnails end before the first command.
            if current.is_none() && !out.is_empty() && !line.trim().is_empty() {
                break;
            }
            continue;
        };
        if let Some((width, height, format, data)) = current.as_mut() {
            if body.starts_with("thumbnail") && body.ends_with(" end") {
                if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data.as_bytes()) {
                    out.push(Thumbnail { width: *width, height: *height, format: format.clone(), data: bytes });
                }
                current = None;
            } else {
                data.push_str(body);
            }
            continue;
        }
        // "thumbnail begin 300x300 12345", "thumbnail_JPG begin 300x300 12345"
        let mut words = body.split_whitespace();
        let (Some(tag), Some("begin"), Some(size)) = (words.next(), words.next(), words.next()) else { continue };
        let format = match tag {
            "thumbnail" => "PNG",
            t => match t.strip_prefix("thumbnail_") {
                Some(f) => f,
                None => continue,
            },
        };
        if let Some((w, h)) = size.split_once('x') {
            if let (Ok(w), Ok(h)) = (w.parse(), h.parse()) {
                current = Some((w, h, format.to_ascii_uppercase(), String::new()));
            }
        }
    }
    out
}

/// The picture to show: the largest PNG, else the largest JPEG.
fn best(thumbs: Vec<Thumbnail>) -> Option<Image> {
    let pick = |format: &str| {
        thumbs
            .iter()
            .filter(|t| t.format == format)
            .max_by_key(|t| t.width * t.height)
            .cloned()
    };
    if let Some(t) = pick("PNG") {
        return Some(Image { bytes: t.data, content_type: "image/png" });
    }
    pick("JPG").map(|t| Image { bytes: t.data, content_type: "image/jpeg" })
}

/// Describe the one plate of a G-code file from its first and last text.
fn describe(head: &str, tail: &str, md5: String) -> Plate {
    let texts = [head, tail];
    let c = comments(&texts);
    let filaments = filaments(&c);
    let weight = c
        .get("total filament used [g]")
        .and_then(|w| w.parse().ok())
        .or_else(|| (!filaments.is_empty()).then(|| filaments.iter().map(|f| f.used_g).sum::<f64>()))
        .filter(|&w: &f64| w > 0.0);
    let text = |key: &str| c.get(key).map(|v| v.trim_matches('"').to_string()).filter(|v| !v.is_empty());
    Plate {
        index: 1,
        printer_model_id: None,
        printer_model: text("printer_model"),
        nozzle_diameters: text("nozzle_diameter"),
        print_time_sec: print_time(&c, &texts),
        weight_g: weight,
        filaments,
        has_thumbnail: best(thumbnails(head)).is_some(),
        gcode_md5: md5,
        bed_type: text("curr_bed_type"),
    }
}

pub fn inspect(path: &Path) -> Result<Package, String> {
    let (head, tail, md5) = read_ends(path)?;
    check_gcode(&head)?;
    Ok(Package { format: PackageFormat::Gcode, plates: vec![describe(&head, &tail, md5)] })
}

/// The file's preview picture.
pub fn thumbnail(path: &Path) -> Option<Image> {
    let mut head = Vec::new();
    std::fs::File::open(path).ok()?.take(HEAD_BYTES as u64).read_to_end(&mut head).ok()?;
    best(thumbnails(&String::from_utf8_lossy(&head)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    /// The shape of an OrcaSlicer 2.4 G-code file for a Klipper printer.
    fn orca() -> (String, String) {
        let png = b64(b"\x89PNG small");
        let big = b64(b"\x89PNG big one");
        let (a, b) = big.split_at(8);
        let head = format!(
            "; HEADER_BLOCK_START\n; generated by OrcaSlicer 2.4.2 on 2026-10-13 at 10:00:00\n\
             ; total layer number: 50\n; filament: 1,3\n; HEADER_BLOCK_END\n\n\
             ; THUMBNAIL_BLOCK_START\n\n; thumbnail begin 32x32 {}\n; {png}\n; thumbnail end\n\
             ; thumbnail_QOI begin 16x16 4\n; cW9pZg==\n; thumbnail_QOI end\n\
             ; thumbnail begin 300x300 {}\n; {a}\n; {b}\n; thumbnail end\n; THUMBNAIL_BLOCK_END\n\n\
             ; EXECUTABLE_BLOCK_START\nM73 P0 R28\nG28\nG1 X10 Y10\n",
            png.len(),
            big.len()
        );
        let tail = "G1 X0\n; EXECUTABLE_BLOCK_END\n\n\
            ; filament used [mm] = 1234.50, 0.00, 100.00\n\
            ; filament used [cm3] = 2.97, 0.00, 0.24\n\
            ; filament used [g] = 3.69, 0.00, 0.30\n\
            ; filament cost = 0.07, 0.00, 0.01\n\
            ; total filament used [g] = 3.99\n\
            ; total layers count = 50\n\
            ; estimated printing time (normal mode) = 1h 2m 3s\n\n\
            ; CONFIG_BLOCK_START\n\
            ; curr_bed_type = Textured PEI Plate\n\
            ; filament_colour = #FF0000;#00FF00;#0000FF\n\
            ; filament_type = PLA;PETG;PLA\n\
            ; nozzle_diameter = 0.4\n\
            ; printer_model = Voron 2.4 350\n\
            ; thumbnails = 32x32/PNG,16x16/QOI,300x300/PNG\n\
            ; CONFIG_BLOCK_END\n"
            .to_string();
        (head, tail)
    }

    #[test]
    fn reads_orcaslicer_comments() {
        let (head, tail) = orca();
        assert!(check_gcode(&head).is_ok());
        let p = describe(&head, &tail, "ABC".into());
        assert_eq!(p.printer_model.as_deref(), Some("Voron 2.4 350"));
        assert_eq!(p.nozzle_diameters.as_deref(), Some("0.4"));
        assert_eq!(p.print_time_sec, Some(3723.0));
        assert_eq!(p.weight_g, Some(3.99));
        assert_eq!(p.bed_type.as_deref(), Some("Textured PEI Plate"));
        assert!(p.has_thumbnail);
        // Filament 2 isn't used.
        let ids: Vec<(u32, &str, &str)> = p.filaments.iter().map(|f| (f.id, f.material.as_str(), f.color.as_str())).collect();
        assert_eq!(ids, vec![(1, "PLA", "#FF0000"), (3, "PLA", "#0000FF")]);
        assert!((p.filaments[0].used_m - 1.2345).abs() < 1e-9);
    }

    #[test]
    fn picks_the_largest_png() {
        let (head, _) = orca();
        let thumbs = thumbnails(&head);
        assert_eq!(thumbs.iter().map(|t| (t.width, t.format.as_str())).collect::<Vec<_>>(), vec![
            (32, "PNG"),
            (16, "QOI"),
            (300, "PNG")
        ]);
        let img = best(thumbs).unwrap();
        assert_eq!((img.bytes.as_slice(), img.content_type), (&b"\x89PNG big one"[..], "image/png"));
    }

    #[test]
    fn reads_prusaslicer_and_cura() {
        let prusa = "; generated by PrusaSlicer 2.8.1\nG28\n";
        let prusa_tail = "; filament used [mm] = 500.0\n; filament used [g] = 1.50\n\
            ; estimated printing time (normal mode) = 25m 10s\n\
            ; filament_type = PETG\n; filament_colour = #FF8000\n; printer_model = MK4S\n; nozzle_diameter = 0.4\n";
        let p = describe(prusa, prusa_tail, String::new());
        assert_eq!((p.printer_model.as_deref(), p.print_time_sec, p.weight_g), (Some("MK4S"), Some(1510.0), Some(1.5)));
        assert_eq!(p.filaments.len(), 1);
        assert_eq!(p.filaments[0].material, "PETG");
        assert!(!p.has_thumbnail);

        let cura = ";FLAVOR:Marlin\n;TIME:6000\n;Filament used: 1.2m\nG28\n";
        let p = describe(cura, "", String::new());
        assert_eq!((p.print_time_sec, p.printer_model.as_deref(), p.filaments.len()), (Some(6000.0), None, 0));
    }

    #[test]
    fn header_names_the_filaments_used() {
        let head = "; HEADER_BLOCK_START\n; filament: 2\n; HEADER_BLOCK_END\nG28\n";
        let tail = "; filament_type = PLA;PETG\n; filament_colour = #FFFFFF;#000000\n";
        let p = describe(head, tail, String::new());
        assert_eq!(p.filaments.iter().map(|f| (f.id, f.material.as_str())).collect::<Vec<_>>(), vec![(2, "PETG")]);
    }

    #[test]
    fn times_parse() {
        assert_eq!(parse_dhms("1d 2h 3m 4s"), Some(93784.0));
        assert_eq!(parse_dhms("45s"), Some(45.0));
        assert_eq!(parse_dhms("soon"), None);
        let bbl = "; model printing time: 20m 1s; total estimated time: 26m 40s\nG28\n";
        assert_eq!(describe(bbl, "", String::new()).print_time_sec, Some(1600.0));
    }

    #[test]
    fn refuses_what_isnt_gcode() {
        assert!(check_gcode("GCDE\u{1}\u{0}").unwrap_err().contains(".bgcode"));
        assert!(check_gcode("solid cube\nfacet normal 0 0 0\n").unwrap_err().contains("doesn't look"));
        assert!(check_gcode("; just a comment\nG1 X1\n").is_ok());
    }

    #[test]
    fn inspects_a_file() {
        let (head, tail) = orca();
        let path = std::env::temp_dir().join(format!("farmslicer-test-{}.gcode", uuid::Uuid::new_v4()));
        std::fs::write(&path, format!("{head}{tail}")).unwrap();
        let pkg = super::super::inspect(&path).unwrap();
        assert_eq!(pkg.format, PackageFormat::Gcode);
        assert_eq!(pkg.plates[0].gcode_md5, hex::encode_upper(Md5::digest(format!("{head}{tail}"))));
        assert_eq!(pkg.plates[0].printer_model.as_deref(), Some("Voron 2.4 350"));
        assert_eq!(thumbnail(&path).unwrap().bytes, b"\x89PNG big one");
        std::fs::remove_file(&path).ok();
    }
}
