//! Printers of every make: the protocols FarmSlicer speaks, what each can
//! do, and the vendor-neutral commands and status the rest of the server
//! uses. Each protocol's driver lives in its own module (`crate::bambu`, ...)
//! and plugs into [`PrinterHub`].

pub mod http;
pub mod hub;
pub mod status;
pub mod tls;

use serde::Serialize;

pub use crate::package::PackageFormat;
pub use hub::{CommandError, DriverHandle, PrinterHub};
pub use status::PrinterStatus;

/// How FarmSlicer talks to a printer (`printers.protocol`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Protocol {
    /// Bambu Lab LAN mode: MQTT status and commands, FTPS uploads.
    Bambu,
    /// Klipper through Moonraker: WebSocket JSON-RPC, HTTP uploads.
    Moonraker,
}

impl Protocol {
    pub const ALL: &[Protocol] = &[Protocol::Bambu, Protocol::Moonraker];

    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.iter().copied().find(|p| p.as_str() == s)
    }

    /// The value stored in `printers.protocol`.
    pub fn as_str(self) -> &'static str {
        match self {
            Protocol::Bambu => "bambu",
            Protocol::Moonraker => "moonraker",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Protocol::Bambu => "Bambu Lab (LAN)",
            Protocol::Moonraker => "Klipper (Moonraker)",
        }
    }

    pub fn capabilities(self) -> Capabilities {
        match self {
            Protocol::Bambu => Capabilities {
                pause: true,
                stop: true,
                speed: Some(SpeedControl::Levels),
                heat: true,
                camera: true,
                filament_mapping: true,
                print_options: &[
                    "bed_leveling",
                    "flow_calibration",
                    "vibration_calibration",
                    "timelapse",
                    "layer_inspect",
                ],
                package: PackageFormat::Bambu3mf,
                outside_pictures: true,
            },
            Protocol::Moonraker => Capabilities {
                pause: true,
                stop: true,
                speed: Some(SpeedControl::Percent),
                heat: true,
                camera: false,
                filament_mapping: false,
                print_options: &[],
                package: PackageFormat::Gcode,
                outside_pictures: true,
            },
        }
    }
}

/// The printer's protocol, if FarmSlicer speaks it.
pub fn protocol_of(p: &crate::db::Printer) -> Option<Protocol> {
    Protocol::parse(&p.protocol)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SpeedControl {
    /// Bambu's four levels: 1 silent, 2 standard, 3 sport, 4 ludicrous.
    Levels,
    /// A speed factor in percent.
    Percent,
}

/// What FarmSlicer can do with a printer of some protocol. The UI shows
/// only the controls a printer has.
#[derive(Debug, Clone, Serialize)]
pub struct Capabilities {
    /// Pause and resume.
    pub pause: bool,
    pub stop: bool,
    pub speed: Option<SpeedControl>,
    /// Set nozzle and bed temperatures (pre-heat, cool down).
    pub heat: bool,
    pub camera: bool,
    /// Prints map the project's filaments to the printer's trays.
    pub filament_mapping: bool,
    /// The [`crate::printing::PrintOptions`] that mean something here.
    pub print_options: &'static [&'static str],
    /// What the printer takes to print.
    pub package: PackageFormat,
    /// Pictures of prints started elsewhere can be fetched from the printer.
    pub outside_pictures: bool,
}

/// A speed change.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Speed {
    Level(u8),
    Percent(u16),
}

/// What can be asked of a printer, whatever its make.
#[derive(Debug, Clone, PartialEq)]
pub enum Command {
    Pause,
    Resume,
    Stop,
    Speed(Speed),
    /// Target temperatures in °C; 0 switches a heater off.
    Heat { nozzle: i64, bed: i64 },
}
