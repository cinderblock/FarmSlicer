//! Reading a sliced Bambu project (`.gcode.3mf`): which plates it holds,
//! what each needs (printer model, nozzle, filaments) and its thumbnail.
//!
//! Layout (Bambu Studio / OrcaSlicer "export plate sliced file"):
//! `Metadata/plate_N.gcode` (+ `.md5`), `Metadata/plate_N.png`, and
//! `Metadata/slice_info.config`, an XML list of plates:
//!
//! ```xml
//! <config><plate>
//!   <metadata key="index" value="1"/>
//!   <metadata key="printer_model_id" value="C12"/>
//!   <metadata key="nozzle_diameters" value="0.4"/>
//!   <metadata key="prediction" value="4405"/>
//!   <metadata key="weight" value="24.60"/>
//!   <filament id="1" tray_info_idx="GFA00" type="PLA" color="#FFFFFF" used_m="8.26" used_g="24.60"/>
//! </plate></config>
//! ```

use std::collections::BTreeMap;
use std::io::Read;
use std::path::Path;

use md5::{Digest, Md5};
use quick_xml::events::{BytesStart, Event};
use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct FilamentUse {
    /// 1-based filament number in the project (`ams_mapping` index + 1).
    pub id: u32,
    pub material: String,
    /// `#RRGGBB`
    pub color: String,
    /// Bambu filament id (`GFA00`), empty for custom filaments.
    pub filament_id: String,
    pub used_g: f64,
    pub used_m: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Plate {
    /// 1-based, as in `Metadata/plate_N.gcode`.
    pub index: u32,
    /// Bambu model id the plate was sliced for (`BL-P001`, `C12`, `N1`, ...).
    pub printer_model_id: Option<String>,
    pub nozzle_diameters: Option<String>,
    pub print_time_sec: Option<f64>,
    pub weight_g: Option<f64>,
    pub filaments: Vec<FilamentUse>,
    pub has_thumbnail: bool,
    /// Upper-case hex MD5 of the plate's G-code.
    pub gcode_md5: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Package {
    /// Only plates that carry G-code, in index order.
    pub plates: Vec<Plate>,
}

impl Package {
    pub fn plate(&self, index: u32) -> Option<&Plate> {
        self.plates.iter().find(|p| p.index == index)
    }
}

pub fn gcode_entry(index: u32) -> String {
    format!("Metadata/plate_{index}.gcode")
}

/// Read a package from disk. Errors are messages for the uploader.
pub fn inspect(path: &Path) -> Result<Package, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("can't open the file: {e}"))?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|_| "this isn't a 3MF file (not a zip archive)".to_string())?;

    let names: Vec<String> = zip.file_names().filter_map(|n| n.ok().map(|n| n.into_owned())).collect();
    let mut gcode_plates: Vec<u32> = names
        .iter()
        .filter_map(|n| n.strip_prefix("Metadata/plate_")?.strip_suffix(".gcode")?.parse().ok())
        .collect();
    gcode_plates.sort_unstable();
    if gcode_plates.is_empty() {
        return Err(
            "this 3MF has no G-code: slice it, then use \"Export plate sliced file\" \
             (a .gcode.3mf) in Bambu Studio or OrcaSlicer"
                .to_string(),
        );
    }

    let info = match zip.by_name("Metadata/slice_info.config") {
        Ok(mut f) => {
            let mut xml = String::new();
            f.read_to_string(&mut xml).map_err(|e| format!("can't read slice_info.config: {e}"))?;
            parse_slice_info(&xml)
        }
        Err(_) => BTreeMap::new(),
    };

    let mut plates = Vec::new();
    for index in gcode_plates {
        let md5 = match read_entry_from(&mut zip, &format!("{}.md5", gcode_entry(index))) {
            Some(bytes) => String::from_utf8_lossy(&bytes).trim().to_uppercase(),
            None => {
                let mut f = zip
                    .by_name(&gcode_entry(index))
                    .map_err(|e| format!("can't read plate {index}: {e}"))?;
                let mut hasher = Md5::new();
                std::io::copy(&mut f, &mut HashWriter(&mut hasher))
                    .map_err(|e| format!("can't read plate {index}: {e}"))?;
                hex::encode_upper(hasher.finalize())
            }
        };
        let meta = info.get(&index).cloned().unwrap_or_default();
        plates.push(Plate {
            index,
            printer_model_id: meta.printer_model_id,
            nozzle_diameters: meta.nozzle_diameters,
            print_time_sec: meta.prediction,
            weight_g: meta.weight,
            filaments: meta.filaments,
            has_thumbnail: names.iter().any(|n| n == &thumbnail_entry(index)),
            gcode_md5: md5,
        });
    }
    Ok(Package { plates })
}

fn thumbnail_entry(index: u32) -> String {
    format!("Metadata/plate_{index}.png")
}

/// The plate's preview image (PNG), if the package has one.
pub fn thumbnail(path: &Path, index: u32) -> Option<Vec<u8>> {
    let file = std::fs::File::open(path).ok()?;
    let mut zip = zip::ZipArchive::new(file).ok()?;
    read_entry_from(&mut zip, &thumbnail_entry(index))
}

fn read_entry_from<R: std::io::Read + std::io::Seek>(zip: &mut zip::ZipArchive<R>, name: &str) -> Option<Vec<u8>> {
    let mut f = zip.by_name(name).ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    Some(buf)
}

struct HashWriter<'a>(&'a mut Md5);

impl std::io::Write for HashWriter<'_> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.update(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[derive(Debug, Clone, Default)]
struct PlateMeta {
    printer_model_id: Option<String>,
    nozzle_diameters: Option<String>,
    prediction: Option<f64>,
    weight: Option<f64>,
    filaments: Vec<FilamentUse>,
}

fn attrs(e: &BytesStart<'_>) -> BTreeMap<String, String> {
    e.attributes()
        .flatten()
        .map(|a| {
            let key: &str = a.key.as_ref();
            (key.to_string(), unescape(&a.value))
        })
        .collect()
}

fn unescape(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

/// Plate index → its metadata.
fn parse_slice_info(xml: &str) -> BTreeMap<u32, PlateMeta> {
    let mut reader = quick_xml::Reader::from_str(xml);
    let mut plates = BTreeMap::new();
    let mut current: Option<(Option<u32>, PlateMeta)> = None;
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) if e.name().as_ref() == "plate" => {
                current = Some((None, PlateMeta::default()));
            }
            Ok(Event::End(e)) if e.name().as_ref() == "plate" => {
                if let Some((Some(index), meta)) = current.take() {
                    plates.insert(index, meta);
                }
            }
            Ok(Event::Empty(e)) | Ok(Event::Start(e)) => {
                let Some((index, meta)) = current.as_mut() else { continue };
                let a = attrs(&e);
                match e.name().as_ref() {
                    "metadata" => {
                        let value = a.get("value").cloned().unwrap_or_default();
                        match a.get("key").map(String::as_str) {
                            Some("index") => *index = value.trim().parse().ok(),
                            Some("printer_model_id") => meta.printer_model_id = Some(value).filter(|v| !v.is_empty()),
                            Some("nozzle_diameters") => meta.nozzle_diameters = Some(value).filter(|v| !v.is_empty()),
                            Some("prediction") => meta.prediction = value.trim().parse().ok(),
                            Some("weight") => meta.weight = value.trim().parse().ok(),
                            _ => {}
                        }
                    }
                    "filament" => {
                        if let Some(id) = a.get("id").and_then(|i| i.trim().parse().ok()) {
                            meta.filaments.push(FilamentUse {
                                id,
                                material: a.get("type").cloned().unwrap_or_default(),
                                color: a.get("color").cloned().unwrap_or_default(),
                                filament_id: a.get("tray_info_idx").cloned().unwrap_or_default(),
                                used_g: a.get("used_g").and_then(|v| v.parse().ok()).unwrap_or(0.0),
                                used_m: a.get("used_m").and_then(|v| v.parse().ok()).unwrap_or(0.0),
                            });
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    plates
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    const SLICE_INFO: &str = r##"<?xml version="1.0" encoding="UTF-8"?>
<config>
  <header><header_item key="X-BBL-Client-Version" value="02.02.00.85"/></header>
  <plate>
    <metadata key="index" value="2"/>
    <metadata key="printer_model_id" value="C12"/>
    <metadata key="nozzle_diameters" value="0.4"/>
    <metadata key="prediction" value="4405"/>
    <metadata key="weight" value="24.60"/>
    <object identify_id="83" name="Bracket &amp; clip" skipped="false"/>
    <filament id="1" tray_info_idx="GFA00" type="PLA" color="#FFFFFF" used_m="8.26" used_g="24.60"/>
    <filament id="3" tray_info_idx="" type="PETG" color="#161616" used_m="0.5" used_g="1.2"/>
  </plate>
</config>"##;

    fn write_package(entries: &[(&str, &[u8])]) -> tempfile_path::TempPath {
        let path = tempfile_path::TempPath::new("gcode.3mf");
        let file = std::fs::File::create(&path.0).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        for (name, data) in entries {
            zip.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
            zip.write_all(data).unwrap();
        }
        zip.finish().unwrap();
        path
    }

    /// A temp file that removes itself (no tempfile crate needed).
    mod tempfile_path {
        pub struct TempPath(pub std::path::PathBuf);
        impl TempPath {
            pub fn new(ext: &str) -> Self {
                Self(std::env::temp_dir().join(format!("farmslicer-test-{}.{ext}", uuid::Uuid::new_v4())))
            }
        }
        impl Drop for TempPath {
            fn drop(&mut self) {
                std::fs::remove_file(&self.0).ok();
            }
        }
    }

    #[test]
    fn reads_plates_and_slice_info() {
        let pkg = write_package(&[
            ("Metadata/slice_info.config", SLICE_INFO.as_bytes()),
            ("Metadata/plate_2.gcode", b"G28\n"),
            ("Metadata/plate_2.gcode.md5", b"abcdef0123456789abcdef0123456789\n"),
            ("Metadata/plate_2.png", b"\x89PNG"),
            ("Metadata/plate_1.png", b"\x89PNG"),
        ]);
        let p = inspect(&pkg.0).unwrap();
        assert_eq!(p.plates.len(), 1, "plate 1 has no G-code");
        let plate = p.plate(2).unwrap();
        assert_eq!(plate.printer_model_id.as_deref(), Some("C12"));
        assert_eq!(plate.print_time_sec, Some(4405.0));
        assert_eq!(plate.weight_g, Some(24.6));
        assert_eq!(plate.gcode_md5, "ABCDEF0123456789ABCDEF0123456789");
        assert!(plate.has_thumbnail);
        assert_eq!(plate.filaments.len(), 2);
        assert_eq!(plate.filaments[1].id, 3);
        assert_eq!(plate.filaments[1].material, "PETG");
        assert_eq!(thumbnail(&pkg.0, 2).as_deref(), Some(&b"\x89PNG"[..]));
    }

    #[test]
    fn computes_md5_without_a_sidecar() {
        let pkg = write_package(&[("Metadata/plate_1.gcode", b"G28\n")]);
        let p = inspect(&pkg.0).unwrap();
        // md5("G28\n")
        assert_eq!(p.plates[0].gcode_md5, hex::encode_upper(Md5::digest(b"G28\n")));
        assert_eq!(p.plates[0].printer_model_id, None);
    }

    #[test]
    fn unsliced_projects_are_refused() {
        let pkg = write_package(&[("3D/3dmodel.model", b"<model/>")]);
        assert!(inspect(&pkg.0).unwrap_err().contains("no G-code"));
        let not_zip = tempfile_path::TempPath::new("3mf");
        std::fs::write(&not_zip.0, b"solid cube").unwrap();
        assert!(inspect(&not_zip.0).unwrap_err().contains("not a zip"));
    }
}
