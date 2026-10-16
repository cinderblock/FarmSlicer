//! What Bambu's own G-code does, as data: which commands appear, with which
//! words and values, how far each printer model moves, and the temperatures
//! each material is printed at.
//!
//! Three files, merged at startup:
//!
//! - `data/orca.json`: harvested from the OrcaSlicer submodule's BBL
//!   profiles (machine templates + filament profiles). A unit test fails
//!   when it is stale; regenerate with
//!   `FARMSLICER_REGEN_GCODE_DATA=1 cargo test gcode::harvest`.
//! - `data/bambustudio.json`: the same, from several BambuStudio releases
//!   (newer start G-code than Orca ships). Regenerate by pointing
//!   `BAMBUSTUDIO_PROFILES` at their `resources/profiles` directories
//!   (`:`-separated, each prefixed `<release>=`) with the same flag.
//! - `data/slicer.json`: written by hand: what the slicer itself writes
//!   between the templates (moves, fans, temperatures, object labels,
//!   progress), with the reason for each.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

use super::lex::{Code, Value as Arg};

/// How a word of a command may be used.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct WordRule {
    /// Seen on its own (`G28 X`).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub flag: bool,
    /// Seen with a substituted value: any number (semantic checks apply).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub any: bool,
    /// Literal values seen, as a range.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
}

impl WordRule {
    pub(super) fn see(&mut self, v: Arg) {
        match v {
            Arg::Flag => self.flag = true,
            Arg::Templated => self.any = true,
            Arg::Num(n) => {
                self.min = Some(self.min.map_or(n, |m| m.min(n)));
                self.max = Some(self.max.map_or(n, |m| m.max(n)));
            }
        }
    }

    pub(super) fn merge(&mut self, o: &WordRule) {
        self.flag |= o.flag;
        self.any |= o.any;
        if let Some(n) = o.min {
            self.see(Arg::Num(n));
        }
        if let Some(n) = o.max {
            self.see(Arg::Num(n));
        }
    }

    /// Whether `v` is like something the vendor writes.
    pub fn allows(&self, v: Arg) -> bool {
        match v {
            Arg::Flag => self.flag,
            Arg::Templated => self.any,
            Arg::Num(n) => {
                self.any || (self.min.is_some_and(|m| n >= m - 1e-9) && self.max.is_some_and(|m| n <= m + 1e-9))
            }
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct CommandRule {
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub words: BTreeMap<String, WordRule>,
    /// Text commands: the first words seen (`judge_flag`, ...).
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub subcommands: BTreeSet<String>,
    /// Text commands whose text is data (`M624`'s object id): any text.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub any_text: bool,
    /// `T`: tool numbers seen literally; `any_tool` = `T[next_extruder]`.
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub tools: BTreeSet<u32>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub any_tool: bool,
    /// Seen with no arguments at all (`M500` alone saves every setting;
    /// Bambu only ever writes `M500 R`).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub bare: bool,
    /// Hand-written data: why the command is allowed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub why: Option<String>,
}

impl CommandRule {
    fn merge(&mut self, o: &CommandRule) {
        for (k, w) in &o.words {
            self.words.entry(k.clone()).or_default().merge(w);
        }
        self.subcommands.extend(o.subcommands.iter().cloned());
        self.any_text |= o.any_text;
        self.tools.extend(o.tools.iter().copied());
        self.any_tool |= o.any_tool;
        self.bare |= o.bare;
        if self.why.is_none() {
            self.why = o.why.clone();
        }
    }
}

/// An axis-aligned box: [min x, min y, max x, max y].
pub type Rect = [f64; 4];

pub(super) fn grow(r: &mut Option<Rect>, x: f64, y: f64) {
    let b = r.get_or_insert([x, y, x, y]);
    b[0] = b[0].min(x);
    b[1] = b[1].min(y);
    b[2] = b[2].max(x);
    b[3] = b[3].max(y);
}

pub(super) fn union(a: &mut Option<Rect>, b: &Option<Rect>) {
    if let Some(b) = b {
        grow(a, b[0], b[1]);
        grow(a, b[2], b[3]);
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct ModelLimits {
    /// Machine profile names of the model.
    #[serde(default)]
    pub names: BTreeSet<String>,
    /// Where objects may be printed (`printable_area`'s bounding box).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bed: Option<Rect>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_z: Option<f64>,
    /// Where the vendor's own templates move the nozzle (absolute moves).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reach: Option<Rect>,
    /// Where the templates take the nozzle below the plate's surface (the
    /// wiper and exposed steel behind the plate), and how low.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub below_plate: Option<Rect>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_z: Option<f64>,
    /// Hottest nozzle / plate / chamber any of the model's templates or
    /// filament profiles asks for.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nozzle_max: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bed_max: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chamber_max: Option<f64>,
    /// Hottest literal nozzle / plate temperature in the model's own
    /// templates, whatever the material (X1E flushes at 290 °C even for PLA).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template_nozzle_max: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template_bed_max: Option<f64>,
    /// Motion limits for estimating time: mm/s, mm/s².
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_speed: Option<[f64; 4]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_accel: Option<f64>,
    /// Other makes: the M-codes and extended commands the printer's own
    /// vendor templates use (a firmware hazard there is the vendor's call).
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub commands: BTreeSet<String>,
}

pub(super) fn max_opt(a: &mut Option<f64>, b: Option<f64>) {
    if let Some(b) = b {
        *a = Some(a.map_or(b, |x| x.max(b)));
    }
}
pub(super) fn min_opt(a: &mut Option<f64>, b: Option<f64>) {
    if let Some(b) = b {
        *a = Some(a.map_or(b, |x| x.min(b)));
    }
}

impl ModelLimits {
    pub(super) fn merge(&mut self, o: &ModelLimits) {
        self.names.extend(o.names.iter().cloned());
        union(&mut self.bed, &o.bed);
        max_opt(&mut self.max_z, o.max_z);
        union(&mut self.reach, &o.reach);
        union(&mut self.below_plate, &o.below_plate);
        min_opt(&mut self.min_z, o.min_z);
        max_opt(&mut self.nozzle_max, o.nozzle_max);
        max_opt(&mut self.bed_max, o.bed_max);
        max_opt(&mut self.chamber_max, o.chamber_max);
        max_opt(&mut self.template_nozzle_max, o.template_nozzle_max);
        max_opt(&mut self.template_bed_max, o.template_bed_max);
        if self.max_speed.is_none() {
            self.max_speed = o.max_speed;
        }
        if self.max_accel.is_none() {
            self.max_accel = o.max_accel;
        }
        self.commands.extend(o.commands.iter().cloned());
    }
}

/// Temperatures a material is printed at, across every vendor profile of it.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct MaterialLimits {
    pub nozzle_min: f64,
    pub nozzle_max: f64,
    /// Hottest plate any profile of the material asks for.
    pub bed_max: f64,
}

impl MaterialLimits {
    pub(super) fn merge(&mut self, o: &MaterialLimits) {
        self.nozzle_min = self.nozzle_min.min(o.nozzle_min);
        self.nozzle_max = self.nozzle_max.max(o.nozzle_max);
        self.bed_max = self.bed_max.max(o.bed_max);
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Data {
    /// Where the data came from.
    #[serde(default)]
    pub sources: Vec<String>,
    /// Commands whose argument is free text.
    #[serde(default)]
    pub text_commands: BTreeSet<String>,
    #[serde(default)]
    pub commands: BTreeMap<String, CommandRule>,
    /// By the model id sliced files and printers report (`BL-P001`).
    #[serde(default)]
    pub models: BTreeMap<String, ModelLimits>,
    /// By material (`PLA`, `PETG-CF`), upper case.
    #[serde(default)]
    pub materials: BTreeMap<String, MaterialLimits>,
    /// Every other make's printers, by the `printer_model` name their
    /// profiles and G-code use ("Prusa MK4S", "Voron 2.4 350"): geometry
    /// and temperatures only. Their G-code isn't held to Bambu's commands.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub printers: BTreeMap<String, ModelLimits>,
    /// Materials across every other vendor's filament profiles, for their
    /// printers' G-code.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub other_materials: BTreeMap<String, MaterialLimits>,
}

impl Data {
    pub fn merge(&mut self, o: &Data) {
        self.sources.extend(o.sources.iter().cloned());
        self.text_commands.extend(o.text_commands.iter().cloned());
        for (k, c) in &o.commands {
            self.commands.entry(k.clone()).or_default().merge(c);
        }
        for (k, m) in &o.models {
            self.models.entry(k.clone()).or_default().merge(m);
        }
        for (k, m) in &o.printers {
            self.printers.entry(k.clone()).or_default().merge(m);
        }
        for (mine, theirs) in [(&mut self.materials, &o.materials), (&mut self.other_materials, &o.other_materials)] {
            for (k, m) in theirs {
                match mine.get_mut(k) {
                    Some(e) => e.merge(m),
                    None => {
                        mine.insert(k.clone(), m.clone());
                    }
                }
            }
        }
    }

    pub fn is_text(&self, code: &Code) -> bool {
        self.text_commands.contains(&code.key())
    }

    /// A Bambu model by id, or (`other`) another make's printer by name.
    pub fn model(&self, id: &str, other: bool) -> Option<&ModelLimits> {
        if other { self.printers.get(id.trim()) } else { self.models.get(id) }
    }

    /// Temperatures for a material: Bambu's profiles of it, or (`other`)
    /// every other vendor's.
    pub fn material(&self, name: &str, other: bool) -> Option<&MaterialLimits> {
        let key = name.trim().to_uppercase();
        let table = if other { &self.other_materials } else { &self.materials };
        // Bambu's support materials print as "PLA-S", "PA-S", "ABS-S"
        // (libslic3r's get_filament_type); their profiles, harvested here,
        // are of the base type.
        table
            .get(&key)
            .or_else(|| key.strip_suffix("-S").and_then(|base| table.get(base)))
    }
}

/// The merged data the checker uses.
pub fn data() -> &'static Data {
    static DATA: OnceLock<Data> = OnceLock::new();
    DATA.get_or_init(|| {
        let mut d = Data::default();
        for (name, text) in [
            ("orca.json", include_str!("data/orca.json")),
            ("bambustudio.json", include_str!("data/bambustudio.json")),
            ("slicer.json", include_str!("data/slicer.json")),
            ("printers.json", include_str!("data/printers.json")),
        ] {
            let part: Data = serde_json::from_str(text).unwrap_or_else(|e| panic!("gcode data {name}: {e}"));
            d.merge(&part);
        }
        d
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merged_data_loads() {
        let d = data();
        assert!(d.commands.contains_key("G1"), "slicer.json lists moves");
    }

    #[test]
    fn rules() {
        let mut w = WordRule::default();
        w.see(Arg::Num(1.0));
        w.see(Arg::Num(5.0));
        assert!(w.allows(Arg::Num(3.0)) && !w.allows(Arg::Num(6.0)) && !w.allows(Arg::Flag));
        w.see(Arg::Templated);
        assert!(w.allows(Arg::Num(600.0)));
    }
}
