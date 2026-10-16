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

use super::{FilamentUse, MAX_GCODE_BYTES, Package, PackageFormat, Plate};

pub fn gcode_entry(index: u32) -> String {
    format!("Metadata/plate_{index}.gcode")
}

/// Read a package from disk. Errors are messages for the uploader.
///
/// The archive's structure is verified first (src/package/zipcheck.rs), and
/// each plate's MD5 is computed from its G-code: a `.md5` entry that
/// disagrees means the G-code was changed after slicing.
pub fn inspect(path: &Path) -> Result<Package, String> {
    let mut file = std::fs::File::open(path).map_err(|e| format!("can't open the file: {e}"))?;
    let entries = super::zipcheck::verify(&mut file)?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|_| "this isn't a 3MF file (not a zip archive)".to_string())?;

    let names: Vec<String> = entries.iter().map(|e| e.name.clone()).collect();
    for e in &entries {
        if e.name.ends_with(".gcode") && e.uncompressed_size > MAX_GCODE_BYTES {
            return Err(format!("{} is too large ({} MB)", e.name, e.uncompressed_size >> 20));
        }
    }
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

    // The build plate: project_settings.config (JSON) holds the whole config.
    let bed_type = read_entry_from(&mut zip, "Metadata/project_settings.config")
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .and_then(|v| v.get("curr_bed_type")?.as_str().map(String::from))
        .filter(|s| !s.is_empty());

    let mut plates = Vec::new();
    for index in gcode_plates {
        let md5 = {
            let f = zip
                .by_name(&gcode_entry(index))
                .map_err(|e| format!("can't read plate {index}: {e}"))?;
            let mut hasher = Md5::new();
            let copied = std::io::copy(&mut f.take(MAX_GCODE_BYTES + 1), &mut HashWriter(&mut hasher))
                .map_err(|e| format!("can't read plate {index}: {e}"))?;
            if copied > MAX_GCODE_BYTES {
                return Err(format!("plate {index}'s G-code is too large"));
            }
            hex::encode_upper(hasher.finalize())
        };
        if let Some(bytes) = read_entry_from(&mut zip, &format!("{}.md5", gcode_entry(index))) {
            let declared = String::from_utf8_lossy(&bytes).trim().to_uppercase();
            if declared != md5 {
                return Err(format!(
                    "plate {index}'s G-code doesn't match its checksum: it was changed after slicing"
                ));
            }
        }
        let meta = info.get(&index).cloned().unwrap_or_default();
        plates.push(Plate {
            index,
            printer_model_id: meta.printer_model_id,
            printer_model: None,
            nozzle_diameters: meta.nozzle_diameters,
            print_time_sec: meta.prediction,
            weight_g: meta.weight,
            filaments: meta.filaments,
            has_thumbnail: names.iter().any(|n| n == &thumbnail_entry(index)),
            gcode_md5: md5,
            bed_type: bed_type.clone(),
            check: None,
        });
    }
    Ok(Package { format: PackageFormat::Bambu3mf, plates })
}

fn thumbnail_entry(index: u32) -> String {
    format!("Metadata/plate_{index}.png")
}

/// The plate's preview image (PNG) from a package in memory.
pub fn thumbnail_from_bytes(bytes: &[u8], index: u32) -> Option<Vec<u8>> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).ok()?;
    read_entry_from(&mut zip, &thumbnail_entry(index))
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
    /// Per project filament (id - 1): the nozzle it prints from (1 left,
    /// 2 right on the H2D; all 1 on single-nozzle printers).
    filament_maps: Vec<i64>,
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
                if let Some((Some(index), mut meta)) = current.take() {
                    // Only dual-nozzle printers say anything with it.
                    if meta.filament_maps.iter().any(|&n| n != 1) {
                        for f in &mut meta.filaments {
                            f.nozzle = meta.filament_maps.get(f.id as usize - 1).copied();
                        }
                    }
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
                            Some("filament_maps") => {
                                meta.filament_maps = value.split_whitespace().filter_map(|n| n.parse().ok()).collect()
                            }
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
                                nozzle: None,
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

    #[test]
    fn filament_maps_give_each_filament_its_nozzle() {
        let xml = r##"<config><plate>
            <metadata key="index" value="1"/>
            <metadata key="filament_maps" value="2 1 1"/>
            <filament id="1" type="PLA" color="#FF0000" used_g="5"/>
            <filament id="2" type="PLA-S" color="#FFFFFF" used_g="1"/>
        </plate><plate>
            <metadata key="index" value="2"/>
            <metadata key="filament_maps" value="1 1"/>
            <filament id="1" type="PLA" color="#FF0000" used_g="5"/>
        </plate></config>"##;
        let plates = parse_slice_info(xml);
        assert_eq!(plates[&1].filaments.iter().map(|f| f.nozzle).collect::<Vec<_>>(), vec![Some(2), Some(1)]);
        // All on nozzle 1: a single-nozzle printer; nothing to say.
        assert_eq!(plates[&2].filaments[0].nozzle, None);
    }
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
            ("Metadata/plate_2.gcode.md5", b"bed3f671261ea5abc6be16b782d1c47b\n"),
            ("Metadata/plate_2.png", b"\x89PNG"),
            ("Metadata/plate_1.png", b"\x89PNG"),
            ("Metadata/project_settings.config", br#"{"curr_bed_type": "Textured PEI Plate"}"#),
        ]);
        let p = inspect(&pkg.0).unwrap();
        assert_eq!(p.plates.len(), 1, "plate 1 has no G-code");
        let plate = p.plate(2).unwrap();
        assert_eq!(plate.printer_model_id.as_deref(), Some("C12"));
        assert_eq!(plate.print_time_sec, Some(4405.0));
        assert_eq!(plate.weight_g, Some(24.6));
        assert_eq!(plate.gcode_md5, "BED3F671261EA5ABC6BE16B782D1C47B");
        assert!(plate.has_thumbnail);
        assert_eq!(plate.filaments.len(), 2);
        assert_eq!(plate.filaments[1].id, 3);
        assert_eq!(plate.filaments[1].material, "PETG");
        assert_eq!(thumbnail(&pkg.0, 2).as_deref(), Some(&b"\x89PNG"[..]));
        assert_eq!(plate.bed_type.as_deref(), Some("Textured PEI Plate"));
    }

    #[test]
    fn computes_md5_without_a_sidecar() {
        let pkg = write_package(&[("Metadata/plate_1.gcode", b"G28\n")]);
        let p = inspect(&pkg.0).unwrap();
        // md5("G28\n")
        assert_eq!(p.plates[0].gcode_md5, hex::encode_upper(Md5::digest(b"G28\n")));
        assert_eq!(p.plates[0].printer_model_id, None);
    }

    /// Real packages (Bambu Studio, OrcaSlicer, FarmSlicer's own) from a
    /// local directory, when `FARMSLICER_SAMPLE_PACKAGES` names one.
    #[test]
    fn sample_packages_pass() {
        let Some(dir) = std::env::var_os("FARMSLICER_SAMPLE_PACKAGES") else { return };
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.to_string_lossy().ends_with(".gcode.3mf") {
                let p = inspect(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
                assert!(!p.plates.is_empty(), "{}", path.display());
            }
        }
    }

    #[test]
    fn a_checksum_that_disagrees_is_refused() {
        let pkg = write_package(&[
            ("Metadata/plate_1.gcode", b"M104 S300\n"),
            ("Metadata/plate_1.gcode.md5", b"ABCDEF0123456789ABCDEF0123456789"),
        ]);
        assert!(inspect(&pkg.0).unwrap_err().contains("changed after slicing"));
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
