//! Harvesting `data/orca.json` and `data/bambustudio.json` from vendor
//! profiles (a dev tool, run through the tests below; see `data`).

use serde_json::{Map, Value};
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};

use super::data::*;
use super::lex::{self, Code, Lexed, Value as Arg};
use super::template;

/// Commands that must stay word-based whatever a template does with them:
/// the checker reads their values.
const NEVER_TEXT: &[&str] = &[
    "M104", "M106", "M107", "M109", "M140", "M141", "M190", "M191", "M204", "M205", "M220", "M221", "M400", "M73",
];

/// Bambu's templates name every command they use, words included (`SYNC`).
fn any_name(_: &str) -> bool {
    true
}

fn see_line(data: &mut Data, line: &str) {
    let probe = |_: &Code| true;
    let c = match lex::lex(line, probe, any_name, true) {
        Lexed::Command(c) => c,
        Lexed::Empty => return,
        Lexed::Unreadable(why) => {
            eprintln!("harvest: skipped a template line ({why}): {line:?}");
            return;
        }
    };
    let key = c.code.key();
    let is_text = data.text_commands.contains(&key)
        || (c.code.letter == b'M'
            && !NEVER_TEXT.contains(&key.as_str())
            && matches!(lex::lex(line, |_| false, any_name, true), Lexed::Unreadable(_)));
    if is_text {
        data.text_commands.insert(key.clone());
    }
    let Lexed::Command(c) = lex::lex(line, |_| is_text, any_name, true) else { return };
    let rule = data.commands.entry(key).or_default();
    if c.code.letter == b'T' {
        if c.code.number == u32::MAX {
            rule.any_tool = true;
        } else {
            rule.tools.insert(c.code.number);
        }
    }
    if let Some(sub) = c.subcommand() {
        if !sub.is_empty() && !sub.contains(lex::PLACEHOLDER) {
            rule.subcommands.insert(sub.to_string());
        }
    }
    if c.words.is_empty() && c.text.is_none() {
        rule.bare = true;
    }
    for w in &c.words {
        rule.words.entry((w.letter as char).to_string()).or_default().see(w.value);
    }
}

/// A template preset's own identity, not settings it gives its includer.
const INCLUDE_META: &[&str] = &["name", "type", "from", "inherits", "include", "instantiation", "setting_id"];

/// Profiles of one vendor directory by name, with `inherits` and `include`
/// resolved.
struct ProfileDir {
    by_name: HashMap<String, Map<String, Value>>,
}

impl ProfileDir {
    fn load(dir: &Path) -> ProfileDir {
        let mut by_name = HashMap::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(d) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&d) else { continue };
            let mut paths: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
            paths.sort();
            for p in paths {
                if p.is_dir() {
                    stack.push(p);
                } else if p.extension().is_some_and(|e| e == "json") {
                    let Ok(text) = std::fs::read_to_string(&p) else { continue };
                    if let Ok(Value::Object(o)) = serde_json::from_str::<Value>(&text) {
                        if let Some(name) = o.get("name").and_then(Value::as_str) {
                            by_name.insert(name.to_string(), o);
                        }
                    }
                }
            }
        }
        ProfileDir { by_name }
    }

    fn resolved(&self, name: &str) -> Map<String, Value> {
        let mut chain = Vec::new();
        let mut current = name.to_string();
        let mut seen = BTreeSet::new();
        while let Some(o) = self.by_name.get(&current) {
            if !seen.insert(current.clone()) {
                break;
            }
            chain.push(o);
            match o.get("inherits").and_then(Value::as_str) {
                Some(p) if !p.is_empty() => current = p.to_string(),
                _ => break,
            }
        }
        // Bambu Studio applies a preset's includes (template presets holding
        // its G-code: "Bambu Lab H2D 0.4 nozzle template
        // change_filament_gcode"), then its own keys.
        let mut out = Map::new();
        for o in chain.into_iter().rev() {
            for name in strings(o.get("include")) {
                match self.by_name.get(&name) {
                    Some(inc) => {
                        for (k, v) in inc {
                            if !INCLUDE_META.contains(&k.as_str()) {
                                out.insert(k.clone(), v.clone());
                            }
                        }
                    }
                    None => eprintln!("harvest: {name:?} (included by {:?}) not found", o.get("name")),
                }
            }
            for (k, v) in o {
                out.insert(k.clone(), v.clone());
            }
        }
        out
    }

    fn of_type<'a>(&'a self, kind: &'a str) -> impl Iterator<Item = (&'a String, &'a Map<String, Value>)> + 'a {
        self.by_name.iter().filter(move |(_, o)| o.get("type").and_then(Value::as_str) == Some(kind))
    }
}

/// Strings of a profile value (string, or list of strings).
fn strings(v: Option<&Value>) -> Vec<String> {
    match v {
        Some(Value::String(s)) => vec![s.clone()],
        Some(Value::Array(a)) => a.iter().filter_map(|x| x.as_str().map(String::from)).collect(),
        _ => Vec::new(),
    }
}

fn first_num(v: Option<&Value>) -> Option<f64> {
    strings(v).first().and_then(|s| s.trim().trim_end_matches('%').parse().ok())
}

fn nums(v: Option<&Value>) -> Vec<f64> {
    strings(v)
        .iter()
        .flat_map(|s| s.split(',').map(str::to_string).collect::<Vec<_>>())
        .filter_map(|s| s.trim().parse().ok())
        .collect()
}

/// `["0x0", "256x0", "256x256", "0x256"]` → bounding box.
fn area(v: Option<&Value>) -> Option<Rect> {
    let mut r = None;
    for p in strings(v).iter().flat_map(|s| s.split(',').map(str::to_string).collect::<Vec<_>>()) {
        let mut it = p.split('x').map(|n| n.trim().parse::<f64>());
        if let (Some(Ok(x)), Some(Ok(y))) = (it.next(), it.next()) {
            grow(&mut r, x, y);
        }
    }
    r
}

/// Where a template moves the nozzle, following G90/G91 within it.
struct Reach {
    absolute: bool,
    pos: [Option<f64>; 3],
    reach: Option<Rect>,
    below: Option<Rect>,
    min_z: Option<f64>,
}

impl Reach {
    fn new() -> Reach {
        Reach { absolute: true, pos: [None; 3], reach: None, below: None, min_z: None }
    }

    fn see(&mut self, data: &Data, line: &str) {
        let Lexed::Command(c) = lex::lex(line, |c| data.is_text(c), |n| data.is_named(n), true) else { return };
        self.see_command(&c);
    }

    fn see_command(&mut self, c: &lex::Command<'_>) {
        if c.code.is(b'G', 90) {
            self.absolute = true;
        } else if c.code.is(b'G', 91) {
            self.absolute = false;
        } else if c.code.is(b'G', 28) {
            self.pos = [None; 3];
        } else if matches!(c.code.key().as_str(), "G0" | "G1" | "G2" | "G3") {
            for (i, l) in [b'X', b'Y', b'Z'].into_iter().enumerate() {
                match c.words.iter().find(|w| w.letter == l).map(|w| w.value) {
                    Some(Arg::Num(n)) if self.absolute => self.pos[i] = Some(n),
                    Some(Arg::Num(n)) => self.pos[i] = self.pos[i].map(|p| p + n),
                    Some(_) => self.pos[i] = None,
                    None => {}
                }
            }
            if let [Some(x), Some(y), _] = self.pos {
                grow(&mut self.reach, x, y);
                if let Some(z) = self.pos[2].filter(|z| *z < 0.0) {
                    grow(&mut self.below, x, y);
                    min_opt(&mut self.min_z, Some(z));
                }
            }
        }
    }
}

const PLATE_TEMPS: &[&str] = &[
    "hot_plate_temp",
    "hot_plate_temp_initial_layer",
    "cool_plate_temp",
    "cool_plate_temp_initial_layer",
    "eng_plate_temp",
    "eng_plate_temp_initial_layer",
    "textured_plate_temp",
    "textured_plate_temp_initial_layer",
    "supertack_plate_temp",
    "supertack_plate_temp_initial_layer",
    "textured_cool_plate_temp",
    "textured_cool_plate_temp_initial_layer",
];

/// Harvest Bambu's vendor directory (`.../profiles/BBL`): commands, models
/// by id, materials.
pub fn harvest(vendor_dir: &Path, source: &str) -> Data {
    let mut data = Data { sources: vec![source.to_string()], ..Default::default() };
    harvest_vendor(vendor_dir, &mut data, true);
    data
}

/// Harvest every other vendor under `profiles` (all but `BBL`): printers by
/// `printer_model` name (geometry, temperatures, motion limits) and
/// materials. No commands: other makes' G-code isn't held to an allowlist.
pub fn harvest_others(profiles: &Path, source: &str) -> Data {
    let mut data = Data { sources: vec![source.to_string()], ..Default::default() };
    let mut vendors: Vec<PathBuf> = std::fs::read_dir(profiles)
        .map(|r| r.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect())
        .unwrap_or_default();
    vendors.sort();
    for v in vendors {
        if v.file_name().is_some_and(|n| n == "BBL") {
            continue;
        }
        harvest_vendor(&v, &mut data, false);
    }
    data
}

/// A template line of another firmware, as `lex_other` reads it.
fn other_line(line: &str) -> Option<lex::Command<'static>> {
    // Leaked per call would be wasteful; re-lex on an owned copy instead.
    let upper = line.to_ascii_uppercase();
    match lex::lex_other(&upper, true) {
        // `lex_other` reads no named commands (those are `Extended`).
        lex::Other::Command(c) => {
            Some(lex::Command { code: lex::Code { name: None, ..c.code }, words: c.words, text: None })
        }
        _ => None,
    }
}

/// Literal temperatures in another firmware's extended commands
/// (`SET_HEATER_TEMPERATURE HEATER=extruder TARGET=250`), and which
/// M-codes and extended commands the vendor's templates use.
fn other_extended_temps(line: &str, lim: &mut ModelLimits) {
    let upper = line.to_ascii_uppercase();
    match lex::lex_other(&upper, true) {
        lex::Other::Command(c) if c.code.letter == b'M' => {
            lim.commands.insert(c.code.key());
        }
        lex::Other::Extended(e) if !e.name.contains(lex::PLACEHOLDER) => {
            lim.commands.insert(e.name.clone());
        }
        _ => {}
    }
    if let lex::Other::Extended(e) = lex::lex_other(&upper, true) {
        if e.name == "SET_HEATER_TEMPERATURE" {
            let target = e.num("TARGET");
            match e.param("HEATER").unwrap_or("") {
                h if h.starts_with("EXTRUDER") => {
                    max_opt(&mut lim.nozzle_max, target);
                    max_opt(&mut lim.template_nozzle_max, target);
                }
                "HEATER_BED" => {
                    max_opt(&mut lim.bed_max, target);
                    max_opt(&mut lim.template_bed_max, target);
                }
                h if h.contains("CHAMBER") => max_opt(&mut lim.chamber_max, target),
                _ => {}
            }
        }
    }
}

fn harvest_vendor(vendor_dir: &Path, data: &mut Data, bambu: bool) {
    let dir = ProfileDir::load(vendor_dir);

    // Model name → id.
    let ids: HashMap<String, String> = dir
        .of_type("machine_model")
        .filter_map(|(name, o)| Some((name.clone(), o.get("model_id")?.as_str()?.to_string())))
        .collect();

    // Two passes over every template: commands first (so text commands are
    // known), then where the moves go.
    let mut machines: Vec<(String, Map<String, Value>)> = dir
        .of_type("machine")
        .filter(|(_, o)| o.get("instantiation").and_then(Value::as_str) != Some("false"))
        .map(|(name, _)| (name.clone(), dir.resolved(name)))
        .collect();
    machines.sort_by(|a, b| a.0.cmp(&b.0));
    let mut filaments: Vec<(String, Map<String, Value>)> = dir
        .of_type("filament")
        .filter(|(_, o)| o.get("instantiation").and_then(Value::as_str) != Some("false"))
        .map(|(name, _)| (name.clone(), dir.resolved(name)))
        .collect();
    filaments.sort_by(|a, b| a.0.cmp(&b.0));

    let templates = |o: &Map<String, Value>| -> Vec<String> {
        let mut keys: Vec<&String> = o.keys().filter(|k| k.ends_with("_gcode")).collect();
        keys.sort();
        keys.into_iter().flat_map(|k| strings(o.get(k))).collect()
    };
    if bambu {
        for (_, m) in machines.iter().chain(filaments.iter()) {
            for t in templates(m) {
                for line in template::lines(&t) {
                    see_line(data, &line);
                }
            }
        }
    }

    // Per model: areas, reach, motion limits.
    let mut machine_model: HashMap<String, String> = HashMap::new();
    for (name, m) in &machines {
        let Some(model) = m.get("printer_model").and_then(Value::as_str) else { continue };
        // Bambu's models by the id its files carry; others' by name.
        let id = if bambu {
            let Some(id) = ids.get(model) else { continue };
            id.clone()
        } else {
            model.trim().to_string()
        };
        machine_model.insert(name.clone(), id.clone());
        let mut lim = ModelLimits { names: [model.to_string()].into(), ..Default::default() };
        lim.bed = area(m.get("printable_area"));
        lim.max_z = first_num(m.get("printable_height"));
        let speeds = ["machine_max_speed_x", "machine_max_speed_y", "machine_max_speed_z", "machine_max_speed_e"]
            .map(|k| first_num(m.get(k)));
        if speeds.iter().all(Option::is_some) {
            lim.max_speed = Some(speeds.map(Option::unwrap));
        }
        lim.max_accel = first_num(m.get("machine_max_acceleration_extruding"));
        for t in templates(m) {
            let mut r = Reach::new();
            for line in template::lines(&t) {
                let command = if bambu {
                    r.see(data, &line);
                    match lex::lex(&line, |c| data.is_text(c), |n| data.is_named(n), true) {
                        Lexed::Command(c) => Some(lex::Command { code: c.code, words: c.words, text: None }),
                        _ => None,
                    }
                } else {
                    other_extended_temps(&line, &mut lim);
                    let c = other_line(&line);
                    if let Some(c) = &c {
                        r.see_command(c);
                    }
                    c
                };
                if let Some(c) = command {
                    let s = c.num(b'S');
                    match c.code.key().as_str() {
                        "M104" | "M109" => {
                            max_opt(&mut lim.nozzle_max, s);
                            max_opt(&mut lim.template_nozzle_max, s);
                        }
                        "M140" | "M190" => {
                            max_opt(&mut lim.bed_max, s);
                            max_opt(&mut lim.template_bed_max, s);
                        }
                        "M141" | "M191" => max_opt(&mut lim.chamber_max, s),
                        _ => {}
                    }
                }
            }
            union(&mut lim.reach, &r.reach);
            union(&mut lim.below_plate, &r.below);
            min_opt(&mut lim.min_z, r.min_z);
        }
        let to = if bambu { &mut data.models } else { &mut data.printers };
        to.entry(id.clone()).or_default().merge(&lim);
    }

    // Materials, and what each model's filaments ask for.
    for (_, f) in &filaments {
        let Some(kind) = strings(f.get("filament_type")).first().map(|s| s.trim().to_uppercase()) else { continue };
        let lows = nums(f.get("nozzle_temperature_range_low"));
        let highs: Vec<f64> = nums(f.get("nozzle_temperature_range_high"))
            .into_iter()
            .chain(nums(f.get("nozzle_temperature")))
            .chain(nums(f.get("nozzle_temperature_initial_layer")))
            .collect();
        let beds: Vec<f64> = PLATE_TEMPS.iter().flat_map(|k| nums(f.get(*k))).collect();
        let (Some(lo), Some(hi)) = (lows.iter().copied().reduce(f64::min), highs.iter().copied().reduce(f64::max)) else {
            continue;
        };
        let bed = beds.iter().copied().fold(0.0, f64::max);
        let m = MaterialLimits { nozzle_min: lo, nozzle_max: hi, bed_max: bed };
        let materials = if bambu { &mut data.materials } else { &mut data.other_materials };
        match materials.get_mut(&kind) {
            Some(e) => e.merge(&m),
            None => {
                materials.insert(kind, m);
            }
        }
        let chamber = nums(f.get("chamber_temperatures")).into_iter().chain(nums(f.get("chamber_temperature"))).reduce(f64::max);
        for printer in strings(f.get("compatible_printers")).iter().flat_map(|s| s.split(';').map(str::to_string).collect::<Vec<_>>()) {
            if let Some(id) = machine_model.get(printer.trim()) {
                let lim = if bambu { &mut data.models } else { &mut data.printers }.entry(id.clone()).or_default();
                max_opt(&mut lim.nozzle_max, Some(hi));
                max_opt(&mut lim.bed_max, Some(bed));
                max_opt(&mut lim.chamber_max, chamber);
            }
        }
    }
}

fn to_json(d: &Data) -> String {
    let mut s = serde_json::to_string_pretty(d).expect("data serializes");
    s.push('\n');
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    }

    fn regen() -> bool {
        std::env::var_os("FARMSLICER_REGEN_GCODE_DATA").is_some()
    }

    /// `data/orca.json` matches the submodule (when it's checked out).
    #[test]
    fn orca_data_is_fresh() {
        let dir = repo().join("extern/OrcaSlicer/resources/profiles/BBL");
        if !dir.is_dir() {
            eprintln!("skipped: no OrcaSlicer profiles at {}", dir.display());
            return;
        }
        let version = std::fs::read_to_string(repo().join("extern/OrcaSlicer/version.inc"))
            .ok()
            .and_then(|v| v.lines().find(|l| l.contains("SoftFever_VERSION")).map(|l| l.split('"').nth(1).unwrap_or("").to_string()))
            .unwrap_or_default();
        let fresh = to_json(&harvest(&dir, &format!("OrcaSlicer {version} profiles/BBL")));
        let path = repo().join("src/gcode/data/orca.json");
        if regen() {
            std::fs::write(&path, &fresh).unwrap();
        }
        let committed = std::fs::read_to_string(&path).unwrap_or_default().replace("\r\n", "\n");
        assert!(
            committed == fresh,
            "src/gcode/data/orca.json is stale: run FARMSLICER_REGEN_GCODE_DATA=1 cargo test gcode::harvest"
        );
    }

    /// `data/printers.json` matches the submodule's other vendors.
    #[test]
    fn printers_data_is_fresh() {
        let dir = repo().join("extern/OrcaSlicer/resources/profiles");
        if !dir.join("Prusa").is_dir() {
            eprintln!("skipped: no OrcaSlicer profiles at {}", dir.display());
            return;
        }
        let version = std::fs::read_to_string(repo().join("extern/OrcaSlicer/version.inc"))
            .ok()
            .and_then(|v| v.lines().find(|l| l.contains("SoftFever_VERSION")).map(|l| l.split('"').nth(1).unwrap_or("").to_string()))
            .unwrap_or_default();
        let fresh = to_json(&harvest_others(&dir, &format!("OrcaSlicer {version} profiles (every vendor but BBL)")));
        let path = repo().join("src/gcode/data/printers.json");
        if regen() {
            std::fs::write(&path, &fresh).unwrap();
        }
        let committed = std::fs::read_to_string(&path).unwrap_or_default().replace("\r\n", "\n");
        assert!(
            committed == fresh,
            "src/gcode/data/printers.json is stale: run FARMSLICER_REGEN_GCODE_DATA=1 cargo test gcode::harvest"
        );
    }

    /// `data/bambustudio.json` from the releases in `BAMBUSTUDIO_PROFILES`.
    #[test]
    fn bambustudio_data() {
        let Some(list) = std::env::var_os("BAMBUSTUDIO_PROFILES") else { return };
        let mut d = Data::default();
        for item in list.to_string_lossy().split(':').filter(|s| !s.is_empty()) {
            let (release, dir) = item.split_once('=').expect("<release>=<dir>");
            d.merge(&harvest(&Path::new(dir).join("BBL"), &format!("BambuStudio {release} profiles/BBL")));
        }
        if regen() {
            std::fs::write(repo().join("src/gcode/data/bambustudio.json"), to_json(&d)).unwrap();
        }
    }

    #[test]
    fn harvests_a_vendor_dir() {
        let dir = std::env::temp_dir().join(format!("farmslicer-harvest-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("machine")).unwrap();
        std::fs::create_dir_all(dir.join("filament")).unwrap();
        let w = |p: &str, v: Value| std::fs::write(dir.join(p), v.to_string()).unwrap();
        w("machine/m.json", serde_json::json!({"type": "machine_model", "name": "Box", "model_id": "BX1"}));
        w("machine/common.json", serde_json::json!({"type": "machine", "name": "box common", "instantiation": "false",
            "printable_area": ["0x0", "200x0", "200x200", "0x200"], "printable_height": "180",
            "machine_end_gcode": "G1 X210 Y-2 F3000\nM104 S0"}));
        // Newer Bambu Studio keeps templates in presets the machine includes.
        w("machine/t.json", serde_json::json!({"type": "machine", "name": "Box 0.4 template change_filament_gcode",
            "instantiation": "false", "change_filament_gcode": "SYNC T{ceil(flush_length / 125) * 5}\nM620.11 H0"}));
        w("machine/b.json", serde_json::json!({"type": "machine", "name": "Box 0.4", "inherits": "box common", "printer_model": "Box",
            "include": ["Box 0.4 template change_filament_gcode"],
            "machine_start_gcode": "M1002 judge_flag x\nG90\nG1 X100 Y205 Z-0.5\nG91\nG1 X5\nM104 S[nozzle_temperature]\nM109 S250\nT[next_extruder]\nT1000"}));
        w("filament/p.json", serde_json::json!({"type": "filament", "name": "PLA x", "filament_type": ["PLA"],
            "nozzle_temperature_range_low": ["190"], "nozzle_temperature_range_high": ["240"], "hot_plate_temp": ["65"],
            "compatible_printers": ["Box 0.4"], "filament_start_gcode": ["M106 P3 S[during_print_exhaust_fan_speed]"]}));
        let d = harvest(&dir, "test");
        std::fs::remove_dir_all(&dir).ok();

        assert!(d.text_commands.contains("M1002"));
        assert!(d.commands["M1002"].subcommands.contains("judge_flag"));
        assert!(d.commands["M104"].words["S"].any && d.commands["M104"].words["S"].allows(Arg::Num(0.0)));
        assert!(d.commands["M106"].words["P"].allows(Arg::Num(3.0)));
        assert!(d.commands["T"].any_tool && d.commands["T"].tools.contains(&1000));
        assert!(d.commands["SYNC"].words["T"].any, "included template, named command");
        assert!(d.commands.contains_key("M620.11"));
        let m = &d.models["BX1"];
        assert_eq!(m.bed, Some([0.0, 0.0, 200.0, 200.0]));
        assert_eq!(m.max_z, Some(180.0));
        assert_eq!(m.reach, Some([100.0, -2.0, 210.0, 205.0]), "relative moves followed");
        assert_eq!(m.below_plate, Some([100.0, 205.0, 105.0, 205.0]));
        assert_eq!(m.min_z, Some(-0.5));
        assert_eq!(m.nozzle_max, Some(250.0));
        assert_eq!(m.bed_max, Some(65.0));
        assert_eq!(d.materials["PLA"], MaterialLimits { nozzle_min: 190.0, nozzle_max: 240.0, bed_max: 65.0 });
    }
}
