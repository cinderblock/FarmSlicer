//! What gets sent to a printer: a sliced Bambu project (`.gcode.3mf`) or
//! plain G-code, and what each plate in it needs (printer model, nozzle,
//! filaments, time) and looks like (thumbnail).
//!
//! Jobs sliced here and sliced files uploaded from any slicer both end up as
//! a [`Package`] stored on the job (`jobs.package_path` + `package_json`).

pub mod bambu;
pub mod gcode;
pub mod zipcheck;

use std::io::Read;
use std::path::Path;

use serde::{Deserialize, Serialize};

/// The file format of a package.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum PackageFormat {
    /// A sliced Bambu project (`.gcode.3mf`). Packages recorded before plain
    /// G-code existed carry no format: they are all this.
    #[default]
    Bambu3mf,
    /// Plain G-code: one plate.
    Gcode,
}

impl PackageFormat {
    /// File name extension, with its dot.
    pub fn extension(self) -> &'static str {
        match self {
            PackageFormat::Bambu3mf => ".gcode.3mf",
            PackageFormat::Gcode => ".gcode",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            PackageFormat::Bambu3mf => "a sliced Bambu project (.gcode.3mf)",
            PackageFormat::Gcode => "plain G-code",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
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
    /// The nozzle it prints from on dual-nozzle printers (H2D), as the
    /// slicer assigned it (slice_info `filament_maps`): 1 left, 2 right.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nozzle: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Plate {
    /// 1-based, as in `Metadata/plate_N.gcode`; always 1 for plain G-code.
    pub index: u32,
    /// Bambu model id the plate was sliced for (`BL-P001`, `C12`, `N1`, ...).
    pub printer_model_id: Option<String>,
    /// The printer model the plate was sliced for, as the slicer's profile
    /// names it (`printer_model`: "Voron 2.4 350", "MK4S", ...).
    #[serde(default)]
    pub printer_model: Option<String>,
    pub nozzle_diameters: Option<String>,
    pub print_time_sec: Option<f64>,
    pub weight_g: Option<f64>,
    pub filaments: Vec<FilamentUse>,
    pub has_thumbnail: bool,
    /// Upper-case hex MD5 of the plate's G-code.
    pub gcode_md5: String,
    /// The build plate it was sliced for (`curr_bed_type`), when known.
    #[serde(default)]
    pub bed_type: Option<String>,
    /// What the G-code check found (src/gcode/), once it has run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub check: Option<crate::gcode::PlateCheck>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Package {
    #[serde(default)]
    pub format: PackageFormat,
    /// Only plates that carry G-code, in index order.
    pub plates: Vec<Plate>,
}

impl Package {
    pub fn plate(&self, index: u32) -> Option<&Plate> {
        self.plates.iter().find(|p| p.index == index)
    }
}

/// The largest plate G-code we read: a day-long print is ~50 MB.
pub const MAX_GCODE_BYTES: u64 = 2 << 30;

/// A picture and its MIME type.
pub struct Image {
    pub bytes: Vec<u8>,
    pub content_type: &'static str,
}

/// Which format the file at `path` is, from its first bytes.
pub fn sniff(path: &Path) -> Result<PackageFormat, String> {
    let mut magic = [0u8; 4];
    let mut file = std::fs::File::open(path).map_err(|e| format!("can't open the file: {e}"))?;
    let n = file.read(&mut magic).map_err(|e| format!("can't read the file: {e}"))?;
    Ok(if n == 4 && magic == *b"PK\x03\x04" { PackageFormat::Bambu3mf } else { PackageFormat::Gcode })
}

/// Read a package from disk, whichever format it is. Errors are messages
/// for the uploader.
pub fn inspect(path: &Path) -> Result<Package, String> {
    match sniff(path)? {
        PackageFormat::Bambu3mf => bambu::inspect(path),
        PackageFormat::Gcode => gcode::inspect(path),
    }
}

/// The plate's preview image, if the package has one.
pub fn thumbnail(path: &Path, format: PackageFormat, index: u32) -> Option<Image> {
    match format {
        PackageFormat::Bambu3mf => {
            bambu::thumbnail(path, index).map(|bytes| Image { bytes, content_type: "image/png" })
        }
        PackageFormat::Gcode => gcode::thumbnail(path),
    }
}
