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
    /// OctoPrint (1.x, 2.0): REST and its push socket.
    OctoPrint,
    /// Prusa printers' PrusaLink: HTTP, polled.
    PrusaLink,
    /// Elegoo Centauri Carbon: SDCP v3 over a WebSocket, HTTP uploads.
    Sdcp,
}

impl Protocol {
    pub const ALL: &[Protocol] =
        &[Protocol::Bambu, Protocol::Moonraker, Protocol::OctoPrint, Protocol::PrusaLink, Protocol::Sdcp];

    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.iter().copied().find(|p| p.as_str() == s)
    }

    /// The value stored in `printers.protocol`.
    pub fn as_str(self) -> &'static str {
        match self {
            Protocol::Bambu => "bambu",
            Protocol::Moonraker => "moonraker",
            Protocol::OctoPrint => "octoprint",
            Protocol::PrusaLink => "prusalink",
            Protocol::Sdcp => "sdcp",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Protocol::Bambu => "Bambu Lab (LAN)",
            Protocol::Moonraker => "Klipper (Moonraker)",
            Protocol::OctoPrint => "OctoPrint",
            Protocol::PrusaLink => "Prusa (PrusaLink)",
            Protocol::Sdcp => "Elegoo Centauri Carbon (SDCP)",
        }
    }

    /// What the admin fills in to connect, for the printer form.
    pub fn connection(self) -> Connection {
        match self {
            Protocol::Bambu => Connection {
                fields: vec![
                    Field::new("address", "IP address", "192.168.1.100"),
                    Field::new("serial_number", "Serial number", "01P00A000000000"),
                    Field::new("access_code", "Access code", "8-character code from the printer's screen").secret(),
                ],
                hint: "The access code is on the printer's screen, in its network / LAN-only settings. \
                       LAN mode and Developer Mode must be on for FarmSlicer to connect.",
            },
            Protocol::Moonraker => Connection {
                fields: vec![
                    Field::new("address", "Address", "192.168.1.50, voron.local:7125 or http://voron.local"),
                    Field::new("access_code", "API key", "Only if the printer doesn't trust this server").secret().optional(),
                ],
                hint: "Moonraker's address: a host (port 7125 is assumed), host:port, or the URL of the \
                       printer's web page (Mainsail/Fluidd, port 80). An API key is needed only when \
                       moonraker.conf doesn't list this server under trusted_clients; Mainsail shows it \
                       under Settings → General.",
            },
            Protocol::OctoPrint => Connection {
                fields: vec![
                    Field::new("address", "Address", "octopi.local, 192.168.1.60:5000 or http://host/octoprint"),
                    Field::new("access_code", "API key", "From OctoPrint: User Settings → Application Keys").secret(),
                ],
                hint: "OctoPrint's address: a host (port 80, as on OctoPi), host:port (OctoPrint itself \
                       listens on 5000), or a URL. Make an application key for FarmSlicer in OctoPrint's \
                       User Settings → Application Keys (or use your API key); the account needs to \
                       be allowed to print and control the printer.",
            },
            Protocol::PrusaLink => Connection {
                fields: vec![
                    Field::new("address", "Address", "prusa-mk4.local or 192.168.1.70"),
                    Field::new("access_code", "PrusaLink password", "From the printer: Settings → Network → PrusaLink")
                        .secret(),
                ],
                hint: "PrusaLink must be on (the printer's Settings → Network → PrusaLink), which also \
                       shows its password. PrusaLink offers pause, resume and stop, but no speed or \
                       temperature control and no camera. Prusa printers check that a file was sliced \
                       for them and ask on their screen if not, holding the print until someone answers.",
            },
            Protocol::Sdcp => Connection {
                fields: vec![
                    Field::new("address", "IP address", "192.168.1.80"),
                    Field::new("serial_number", "Mainboard ID", "Learnt from the printer when empty").optional(),
                ],
                hint: "The Centauri Carbon (and Centauri) needs no password on the LAN. It takes five \
                       connections in all (the Elegoo app, slicers and Home Assistant count) and about \
                       one camera viewer. The Centauri Carbon 2 speaks another protocol and isn't \
                       supported.",
            },
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
            Protocol::Sdcp => Capabilities {
                pause: true,
                stop: true,
                // Its four presets: 50, 100, 130, 160 %.
                speed: Some(SpeedControl::Levels),
                heat: true,
                camera: true,
                filament_mapping: false,
                print_options: &["bed_leveling", "timelapse"],
                package: PackageFormat::Gcode,
                outside_pictures: true,
            },
            Protocol::PrusaLink => Capabilities {
                pause: true,
                stop: true,
                speed: None,
                heat: false,
                camera: false,
                filament_mapping: false,
                print_options: &[],
                package: PackageFormat::Gcode,
                outside_pictures: true,
            },
            // Klipper and OctoPrint: the same controls.
            Protocol::Moonraker | Protocol::OctoPrint => Capabilities {
                pause: true,
                stop: true,
                speed: Some(SpeedControl::Percent),
                heat: true,
                camera: true,
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

/// One connection setting on the printer form. `key` names the printer
/// field it's stored in (`address`, `serial_number`, `access_code`).
#[derive(Debug, Clone, Serialize)]
pub struct Field {
    pub key: &'static str,
    pub label: &'static str,
    pub placeholder: &'static str,
    pub required: bool,
    /// Write-only, like the Bambu access code: never sent back.
    pub secret: bool,
}

impl Field {
    fn new(key: &'static str, label: &'static str, placeholder: &'static str) -> Self {
        Self { key, label, placeholder, required: true, secret: false }
    }

    fn secret(mut self) -> Self {
        self.secret = true;
        self
    }

    fn optional(mut self) -> Self {
        self.required = false;
        self
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Connection {
    pub fields: Vec<Field>,
    pub hint: &'static str,
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
