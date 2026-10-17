//! Which nozzle prints each filament on dual-nozzle printers (Bambu H2D).
//!
//! libslic3r would choose by itself ("Auto For Flush": least purging). The
//! farm decides instead, in this order:
//!
//! 1. what a nozzle can print at all (`filament_printable`: the H2D prints
//!    PET-CF from its left nozzle only);
//! 2. what the printers the job may go to have loaded: a filament found on
//!    one side's AMS (or on that side on more of the printers, or in a
//!    closer colour) prints from that side's nozzle;
//! 3. the printer's priority (`printers.nozzle_priority`): supports on one
//!    nozzle, parts on the other. Once loaded filaments fix where the
//!    supports (or the parts) go, the rest keep to the other side, so parts
//!    and supports don't share a nozzle.
//!
//! The result goes to libslic3r as a Manual `filament_map` (1 left,
//! 2 right). slice_core still moves a filament the chosen nozzle can't
//! reach everywhere (the H2D's nozzles each miss a strip of the bed).

use serde::Serialize;

use crate::printer::status::PrinterStatus;

pub const LEFT: i64 = 1;
pub const RIGHT: i64 = 2;

/// Colours closer than this (redmean distance) count as the same spool
/// colour.
const SAME_COLOUR: f64 = 80.0;

/// A dual-nozzle printer's preference for filaments its AMS doesn't settle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Priority {
    /// Supports on the right nozzle, parts on the left (the default).
    SupportRight,
    /// Supports on the left nozzle, parts on the right.
    SupportLeft,
    /// Leave it to libslic3r (least purging; ignores the AMS).
    Slicer,
}

/// `printers.nozzle_priority` values; '' = the default.
pub const PRIORITY_VALUES: &[&str] = &["", "support-right", "support-left", "slicer"];

impl Priority {
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim() {
            "" | "support-right" => Some(Self::SupportRight),
            "support-left" => Some(Self::SupportLeft),
            "slicer" => Some(Self::Slicer),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::SupportRight => "support-right",
            Self::SupportLeft => "support-left",
            Self::Slicer => "slicer",
        }
    }

    fn support_nozzle(self) -> i64 {
        if self == Self::SupportLeft { LEFT } else { RIGHT }
    }
}

/// One of the job's filaments, as far as choosing a nozzle goes.
#[derive(Debug, Clone)]
pub struct Filament {
    /// What printers call it ("PLA", "PLA-S", ...; `FilamentInfo::tray_material`).
    pub material: String,
    /// `#RRGGBB`, when the job says.
    pub colour: Option<String>,
    /// Prints supports only (a support material, or the support base or
    /// interface filament when that isn't the part's).
    pub support: bool,
    /// `filament_printable`: bit 0 the left nozzle, bit 1 the right.
    pub printable: u8,
}

/// Where one filament prints, and why.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Choice {
    /// 1 left, 2 right.
    pub nozzle: i64,
    /// What decided it: "printable", "loaded" or "priority".
    pub basis: &'static str,
    /// For people: "loaded on the left", "supports print on the right", ...
    pub why: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Plan {
    /// The priority that applied (`Priority::as_str`).
    pub priority: &'static str,
    /// How many printers' AMS were consulted.
    pub printers: usize,
    /// Filament 1, 2, ...
    pub filaments: Vec<Choice>,
}

impl Plan {
    /// libslic3r's `filament_map`.
    pub fn map(&self) -> Vec<i64> {
        self.filaments.iter().map(|c| c.nozzle).collect()
    }
}

pub fn side_name(nozzle: i64) -> &'static str {
    if nozzle == LEFT { "left" } else { "right" }
}

fn other(nozzle: i64) -> i64 {
    if nozzle == LEFT { RIGHT } else { LEFT }
}

/// The nozzle for each filament (see the module comment). `statuses` are
/// the printers the job may go to; only online ones that say which nozzle
/// their trays feed count. None when the priority leaves it to the slicer.
pub fn plan(filaments: &[Filament], statuses: &[PrinterStatus], priority: Priority) -> Option<Plan> {
    if priority == Priority::Slicer || filaments.is_empty() {
        return None;
    }
    let statuses: Vec<&PrinterStatus> = statuses
        .iter()
        .filter(|s| s.online && s.loaded_trays().iter().any(|t| t.nozzle.is_some()))
        .collect();

    // What can only go one way: physically, then by what's loaded.
    let mut choices: Vec<Option<Choice>> = filaments
        .iter()
        .map(|f| match f.printable & 3 {
            1 => Some(Choice { nozzle: LEFT, basis: "printable", why: "only the left nozzle prints it".into() }),
            2 => Some(Choice { nozzle: RIGHT, basis: "printable", why: "only the right nozzle prints it".into() }),
            _ => loaded_side(f, &statuses),
        })
        .collect();

    // Where the supports go: where loaded (or printable-only) support
    // filaments already are, else away from such part filaments, else the
    // priority.
    let settled_side = |support: bool| -> Option<i64> {
        let mut sides = filaments
            .iter()
            .zip(&choices)
            .filter(|(f, _)| f.support == support)
            .filter_map(|(_, c)| c.as_ref().map(|c| c.nozzle));
        let first = sides.next()?;
        sides.all(|s| s == first).then_some(first)
    };
    enum From {
        Supports,
        Parts,
        Setting,
    }
    let (support_side, from) = match (settled_side(true), settled_side(false)) {
        (Some(side), _) => (side, From::Supports),
        (None, Some(side)) => (other(side), From::Parts),
        (None, None) => (priority.support_nozzle(), From::Setting),
    };

    for (f, choice) in filaments.iter().zip(choices.iter_mut()) {
        if choice.is_some() {
            continue;
        }
        let nozzle = if f.support { support_side } else { other(support_side) };
        let side = side_name(nozzle);
        let why = match (&from, f.support) {
            (From::Setting, true) => format!("supports print on the {side} (printer setting)"),
            (From::Setting, false) => format!("parts print on the {side} (printer setting)"),
            (From::Supports, true) => format!("with the other support filament, on the {side}"),
            (From::Supports, false) => format!("kept apart from the supports, on the {side}"),
            (From::Parts, true) => format!("kept apart from the parts, on the {side}"),
            (From::Parts, false) => format!("with the other part filament, on the {side}"),
        };
        *choice = Some(Choice { nozzle, basis: "priority", why });
    }

    Some(Plan {
        priority: priority.as_str(),
        printers: statuses.len(),
        filaments: choices.into_iter().map(|c| c.expect("every filament chosen")).collect(),
    })
}

/// The side the target printers have `f` loaded on, if one side wins: more
/// printers with the material there, then more in a close colour.
fn loaded_side(f: &Filament, statuses: &[&PrinterStatus]) -> Option<Choice> {
    let mut score = [(0usize, 0usize); 2];
    for s in statuses {
        for (i, side) in [LEFT, RIGHT].into_iter().enumerate() {
            let trays: Vec<_> = s
                .loaded_trays()
                .into_iter()
                .filter(|t| t.nozzle == Some(side))
                .filter(|t| t.material.as_deref().is_some_and(|m| m.eq_ignore_ascii_case(&f.material)))
                .collect();
            if trays.is_empty() {
                continue;
            }
            score[i].0 += 1;
            let close = |t: &&crate::printer::status::Tray| match (&f.colour, &t.color) {
                (Some(want), Some(have)) => crate::printing::color_distance(want, have) < SAME_COLOUR,
                _ => false,
            };
            if trays.iter().any(close) {
                score[i].1 += 1;
            }
        }
    }
    let (left, right) = (score[0], score[1]);
    if left == right {
        return None;
    }
    let (nozzle, won, lost) = if left > right { (LEFT, left, right) } else { (RIGHT, right, left) };
    let side = side_name(nozzle);
    let why = match (statuses.len(), won.0 == lost.0) {
        (1, false) => format!("loaded on the {side}"),
        (1, true) => format!("this colour is loaded on the {side}"),
        (n, false) => format!("loaded on the {side} on {} of {n} printers", won.0),
        (n, true) => format!("this colour is loaded on the {side} on {} of {n} printers", won.1),
    };
    Some(Choice { nozzle, basis: "loaded", why })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::printer::status::{AmsUnit, Tray};

    fn filament(material: &str, support: bool) -> Filament {
        Filament { material: material.into(), colour: None, support, printable: 3 }
    }

    /// An online H2D: AMS 0 on the left nozzle, AMS 1 on the right.
    fn h2d(left: &[(&str, &str)], right: &[(&str, &str)]) -> PrinterStatus {
        let unit = |id: i64, nozzle: i64, trays: &[(&str, &str)]| AmsUnit {
            id,
            humidity: None,
            nozzle: Some(nozzle),
            trays: trays
                .iter()
                .enumerate()
                .map(|(i, (material, color))| Tray {
                    slot: id * 4 + i as i64,
                    unit: Some(id),
                    index: i as i64,
                    material: Some((*material).into()),
                    color: Some((*color).into()),
                    name: None,
                    remain: None,
                    nozzle_temp_min: None,
                    nozzle_temp_max: None,
                    nozzle: Some(nozzle),
                })
                .collect(),
        };
        let mut s = PrinterStatus::offline("h2d", None);
        s.online = true;
        s.ams = vec![unit(0, LEFT, left), unit(1, RIGHT, right)];
        s
    }

    fn nozzles(plan: &Option<Plan>) -> Vec<i64> {
        plan.as_ref().expect("a plan").map()
    }

    #[test]
    fn priority_alone_puts_supports_right_and_parts_left() {
        let fs = [filament("PLA", false), filament("PLA-S", true)];
        let p = plan(&fs, &[], Priority::SupportRight);
        assert_eq!(nozzles(&p), vec![LEFT, RIGHT]);
        let p = p.unwrap();
        assert_eq!((p.priority, p.printers), ("support-right", 0));
        assert!(p.filaments.iter().all(|c| c.basis == "priority"));
        assert_eq!(p.filaments[1].why, "supports print on the right (printer setting)");
        assert_eq!(nozzles(&plan(&fs, &[], Priority::SupportLeft)), vec![RIGHT, LEFT]);
        // One filament, no supports: the parts' side.
        assert_eq!(nozzles(&plan(&fs[..1], &[], Priority::SupportRight)), vec![LEFT]);
        assert!(plan(&fs, &[], Priority::Slicer).is_none());
        assert_eq!(Priority::parse(""), Some(Priority::SupportRight));
        assert_eq!(Priority::parse("nonsense"), None);
    }

    #[test]
    fn what_is_loaded_comes_first() {
        let fs = [filament("PLA", false), filament("PLA-S", true)];
        // Support loaded on the left only; PLA on both sides: the support
        // goes left, the part keeps away from it.
        let s = h2d(&[("PLA", "#FFFFFF"), ("PLA-S", "#FFFFFF")], &[("PLA", "#000000")]);
        let p = plan(&fs, &[s], Priority::SupportRight).unwrap();
        assert_eq!(p.map(), vec![RIGHT, LEFT]);
        assert_eq!(p.filaments[1].basis, "loaded");
        assert_eq!(p.filaments[1].why, "loaded on the left");
        assert_eq!(p.filaments[0].why, "kept apart from the supports, on the right");
        // Part loaded on the right only: supports go left.
        let s = h2d(&[], &[("pla", "#FFFFFF")]);
        assert_eq!(nozzles(&plan(&fs, &[s], Priority::SupportRight)), vec![RIGHT, LEFT]);
        // Both loaded where the priority wants them: as the priority says.
        let s = h2d(&[("PLA", "#FFFFFF")], &[("PLA-S", "#FFFFFF")]);
        assert_eq!(nozzles(&plan(&fs, &[s], Priority::SupportRight)), vec![LEFT, RIGHT]);
    }

    #[test]
    fn colour_breaks_a_tie() {
        let mut part = filament("PLA", false);
        part.colour = Some("#FAFAFA".into());
        let s = h2d(&[("PLA", "#000000")], &[("PLA", "#FFFFFF")]);
        let p = plan(&[part], &[s], Priority::SupportRight).unwrap();
        assert_eq!(p.map(), vec![RIGHT]);
        assert_eq!(p.filaments[0].why, "this colour is loaded on the right");
    }

    #[test]
    fn printable_nozzles_are_respected() {
        // The H2D prints PET-CF from its left nozzle only (`filament_printable` 1).
        let mut part = filament("PET-CF", false);
        part.printable = 1;
        let fs = [part, filament("PLA-S", true)];
        // Supports would go left by the priority; the part has to.
        let p = plan(&fs, &[], Priority::SupportLeft).unwrap();
        assert_eq!(p.map(), vec![LEFT, RIGHT]);
        assert_eq!(p.filaments[0].basis, "printable");
        assert_eq!(p.filaments[0].why, "only the left nozzle prints it");
        assert_eq!(p.filaments[1].why, "kept apart from the parts, on the right");
        // Right only, likewise.
        let mut part = filament("PLA", false);
        part.printable = 2;
        assert_eq!(nozzles(&plan(&[part, filament("PLA-S", true)], &[], Priority::SupportRight)), vec![RIGHT, LEFT]);
    }

    #[test]
    fn several_printers_vote() {
        let fs = [filament("PLA", false), filament("PLA-S", true)];
        let a = h2d(&[("PLA-S", "#FFFFFF")], &[]);
        let b = h2d(&[], &[("PLA-S", "#FFFFFF")]);
        let c = h2d(&[], &[("PLA-S", "#FFFFFF")]);
        let p = plan(&fs, &[a, b, c], Priority::SupportLeft).unwrap();
        assert_eq!(p.map(), vec![LEFT, RIGHT]);
        assert_eq!(p.filaments[1].why, "loaded on the right on 2 of 3 printers");
        assert_eq!(p.printers, 3);
        // Offline printers and ones that don't say which nozzle a tray
        // feeds don't count.
        let mut offline = h2d(&[("PLA-S", "#FFFFFF")], &[]);
        offline.online = false;
        let mut single = PrinterStatus::offline("x1c", None);
        single.online = true;
        let p = plan(&fs, &[offline, single], Priority::SupportRight).unwrap();
        assert_eq!((p.map(), p.printers), (vec![LEFT, RIGHT], 0));
    }
}
