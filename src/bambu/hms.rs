//! What a Bambu printer's error codes mean, in the words Bambu's own apps
//! use: HMS codes and `print_error`.
//!
//! `data/hms.json` is harvested from Bambu's message tables, one per device
//! type (the first 3 characters of the serial): every code's most common
//! text, and the device types whose text differs. Regenerate with
//! `node src/bambu/data/harvest-hms.mjs`.

use serde::Deserialize;
use std::collections::HashMap;
use std::sync::OnceLock;

use crate::printer::status::PrinterStatus;

#[derive(Deserialize, Default)]
struct Texts {
    #[serde(default)]
    hms: HashMap<String, String>,
    #[serde(default)]
    errors: HashMap<String, String>,
}

#[derive(Deserialize)]
struct Tables {
    #[serde(flatten)]
    common: Texts,
    by_device: HashMap<String, Texts>,
}

fn tables() -> &'static Tables {
    static TABLES: OnceLock<Tables> = OnceLock::new();
    TABLES.get_or_init(|| serde_json::from_str(include_str!("data/hms.json")).expect("bambu/data/hms.json parses"))
}

fn lookup(serial: &str, code: &str, pick: fn(&Texts) -> &HashMap<String, String>) -> Option<String> {
    let t = tables();
    serial
        .get(..3)
        .and_then(|device| t.by_device.get(&device.to_ascii_uppercase()))
        .and_then(|d| pick(d).get(code))
        .or_else(|| pick(&t.common).get(code))
        .cloned()
}

/// The text for an HMS code (`attr`, `code` as reported) on the printer with
/// this serial; `None` for codes Bambu doesn't explain.
pub fn hms_message(serial: &str, attr: i64, code: i64) -> Option<String> {
    let key = format!("{:08X}{:08X}", attr & 0xFFFF_FFFF, code & 0xFFFF_FFFF);
    lookup(serial, &key, |t| &t.hms)
}

/// The text for a `print_error` on the printer with this serial.
pub fn error_message(serial: &str, print_error: i64) -> Option<String> {
    lookup(serial, &format!("{:08X}", print_error & 0xFFFF_FFFF), |t| &t.errors)
}

/// Fill in the texts for a status's HMS codes and `print_error`.
pub fn describe(status: &mut PrinterStatus, serial: &str) {
    for h in &mut status.hms {
        h.message = hms_message(serial, h.attr, h.code);
    }
    status.print_error_message = status.print_error.and_then(|e| error_message(serial, e));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn print_errors_read_like_bambu_studio() {
        // What Bambu Studio showed for an X1C asking for filament by hand.
        assert_eq!(
            error_message("00M00A000000000", 0x07FF_8006).as_deref(),
            Some("Please feed filament into the PTFE tube until it can not be pushed any farther.")
        );
        assert_eq!(error_message("01P00A000000000", 0x0300_400C).as_deref(), Some("The task was canceled."));
        assert_eq!(error_message("01P00A000000000", 0x7FFF_FFFF), None);
    }

    #[test]
    fn device_types_get_their_own_text() {
        // Dual-nozzle printers name the extruder.
        assert_eq!(
            error_message("094ABC", 0x07FF_8006).as_deref(),
            Some("Please feed filament into the PTFE tube of the right extruder until it can not be pushed any farther.")
        );
        // An unknown device type (or no serial) gets the common text.
        assert!(error_message("", 0x07FF_8006).unwrap().starts_with("Please feed filament into the PTFE tube until"));
        assert!(error_message("ZZZ1", 0x07FF_8006).unwrap().starts_with("Please feed filament into the PTFE tube until"));
    }

    #[test]
    fn hms_codes_are_attr_then_code() {
        assert_eq!(
            hms_message("00M", 0x0700_2000, 0x0002_0001).as_deref(),
            Some("AMS A Slot 1 filament has run out. Please insert a new filament.")
        );
    }
}
