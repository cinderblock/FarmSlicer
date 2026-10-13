//! What the UI shows for a printer, whatever its make.
//!
//! Every driver turns its printer's reports into a [`PrinterStatus`]. The
//! `state` vocabulary is shared (see [`PrinterStatus::state`]); fields a
//! protocol has no notion of stay empty (AMS trays, HMS codes and
//! `print_error` are Bambu's).

use serde::Serialize;

/// The normalized printer states.
pub mod state {
    pub const IDLE: &str = "IDLE";
    /// Getting ready to print: heating, levelling, homing.
    pub const PREPARE: &str = "PREPARE";
    pub const RUNNING: &str = "RUNNING";
    pub const PAUSE: &str = "PAUSE";
    pub const FINISH: &str = "FINISH";
    pub const FAILED: &str = "FAILED";
    /// Stopped by a person.
    pub const CANCELLED: &str = "CANCELLED";
    /// Bambu printers slicing a cloud job on board.
    pub const SLICING: &str = "SLICING";

    /// The printer is working on a job (sending another would interfere).
    pub fn is_busy(state: Option<&str>) -> bool {
        matches!(state, Some(PREPARE | RUNNING | PAUSE | SLICING))
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Temperature {
    pub current: f64,
    pub target: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Tray {
    /// The slot number print commands use: `unit * 4 + index` for AMS trays,
    /// 254/255 for external spools.
    pub slot: i64,
    pub unit: Option<i64>,
    pub index: i64,
    /// Material ("PLA", "PETG-CF", ...); `None` for an empty slot.
    pub material: Option<String>,
    /// `#RRGGBB`
    pub color: Option<String>,
    pub name: Option<String>,
    /// Percent left, when the AMS knows (Bambu RFID spools).
    pub remain: Option<i64>,
    pub nozzle_temp_min: Option<i64>,
    pub nozzle_temp_max: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AmsUnit {
    pub id: i64,
    pub humidity: Option<i64>,
    /// Which nozzle the unit feeds on dual-nozzle printers (H2D): 1 left,
    /// 2 right. `None` on single-nozzle printers.
    pub nozzle: Option<i64>,
    pub trays: Vec<Tray>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct HmsCode {
    pub attr: i64,
    pub code: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
pub struct PrinterStatus {
    pub printer_id: String,
    pub online: bool,
    /// Why the connection is down, while it is.
    pub connection_error: Option<String>,
    /// Time of the last report, RFC 3339.
    pub updated_at: Option<String>,
    /// One of [`state`]'s values; `None` until the printer says.
    pub state: Option<String>,
    /// The state as the printer named it, when that says more than `state`
    /// (Moonraker's "standby", PrusaLink's "ATTENTION", ...).
    pub vendor_state: Option<String>,
    /// Bambu `stg_cur`: the current preparation stage.
    pub stage: Option<i64>,
    pub percent: Option<i64>,
    pub remaining_minutes: Option<i64>,
    pub layer: Option<i64>,
    pub total_layers: Option<i64>,
    /// The current (or last) job, for people.
    pub job_name: Option<String>,
    /// What the printer calls the current job, as reported: matches the
    /// job name FarmSlicer sends. `None` when the printer doesn't name it.
    pub job_key: Option<String>,
    /// The file the printer is printing, as reported (Bambu: the plate
    /// extracted from the project, `/data/Metadata/plate_1.gcode`).
    pub job_file: Option<String>,
    /// The printer's own error or notice text, while there is one.
    pub message: Option<String>,
    /// Bambu `print_error`, when non-zero.
    pub print_error: Option<i64>,
    /// Bambu HMS codes.
    pub hms: Vec<HmsCode>,
    pub nozzles: Vec<Temperature>,
    pub bed: Option<Temperature>,
    pub chamber: Option<f64>,
    /// Bambu speed level: 1 silent, 2 standard, 3 sport, 4 ludicrous.
    pub speed_level: Option<i64>,
    /// Speed factor in percent, for printers that take one.
    pub speed_percent: Option<i64>,
    pub wifi_signal: Option<String>,
    pub nozzle_diameter: Option<String>,
    pub ams: Vec<AmsUnit>,
    pub external: Vec<Tray>,
    /// Slot feeding the nozzle now (see [`Tray::slot`]).
    pub active_slot: Option<i64>,
}

impl PrinterStatus {
    pub fn offline(printer_id: &str, error: Option<String>) -> Self {
        Self {
            printer_id: printer_id.to_string(),
            connection_error: error,
            ..Default::default()
        }
    }

    /// Every loaded tray: AMS units, then external spools.
    pub fn loaded_trays(&self) -> Vec<&Tray> {
        self.ams
            .iter()
            .flat_map(|u| u.trays.iter())
            .chain(self.external.iter())
            .filter(|t| t.material.is_some())
            .collect()
    }
}
