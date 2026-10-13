//! Run a plate's G-code through a model of the printer and report what it
//! would do that Bambu's own G-code never does.
//!
//! G-code is straight-line: no loops, no jumps, no variables. Bambu's only
//! control flow, `M622`/`M623` blocks guarded by printer flags, is checked
//! as if every block runs. So the check is a complete simulation, not a
//! scan for bad patterns: every command is read, every position, temperature
//! and dwell is known (or known to be unknown), and the totals are computed
//! rather than taken from the file's own metadata.
//!
//! Severities:
//! - `block`: we can't tell what the printer would do (lines its firmware
//!   might read differently from us). Nobody can send it through FarmSlicer.
//!   Only for Bambu's firmware, whose syntax the lexer follows: for plain
//!   G-code (other firmware) a line we can't read needs review instead.
//! - `review`: we can tell, and it's outside what Bambu's G-code does. An
//!   admin may approve it.
//! - `info`: worth knowing, not a problem.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::BufRead;

use super::data::{Data, ModelLimits};
use super::lex::{self, Command, Lexed, Value};

/// Bumped whenever the checker changes what it reports, so stored results
/// from an older checker are redone.
pub const CHECKER_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Info,
    Review,
    Block,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Finding {
    pub severity: Severity,
    /// Stable identifier of the kind of finding (`unknown_command`, ...).
    pub code: String,
    pub message: String,
    /// First line it happened on (1-based).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u64>,
    /// How many times it happened.
    pub count: u64,
}

/// What the G-code does, worked out from the G-code.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Stats {
    pub lines: u64,
    pub commands: u64,
    /// Estimated print time (motion, dwells and heating).
    pub time_sec: f64,
    /// Filament pushed through the nozzle, per tool (0-based), mm.
    pub filament_mm: BTreeMap<u32, f64>,
    /// The same in grams, with the package's densities.
    pub filament_g: BTreeMap<u32, f64>,
    pub max_nozzle_c: f64,
    pub max_bed_c: f64,
    pub max_chamber_c: f64,
    /// Longest stretch with a heater on and nothing extruded.
    pub longest_heated_idle_sec: f64,
    pub longest_dwell_sec: f64,
}

impl Stats {
    pub fn total_g(&self) -> f64 {
        self.filament_g.values().sum()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlateCheck {
    /// Which checker, data and limits produced this (see
    /// `gcode::fingerprint`); a different one means "check again".
    pub checker: String,
    /// The worst severity found; `None` = nothing at all.
    pub verdict: Option<Severity>,
    pub findings: Vec<Finding>,
    pub stats: Stats,
    /// The print time and filament to go by: what the package says, unless
    /// its G-code clearly takes longer or uses more (then the G-code's).
    #[serde(default)]
    pub time_sec: f64,
    #[serde(default)]
    pub grams: f64,
    /// Per filament id (1-based), grams to go by.
    #[serde(default)]
    pub filament_g: BTreeMap<u32, f64>,
}

impl PlateCheck {
    pub fn needs_review(&self) -> bool {
        self.verdict >= Some(Severity::Review)
    }
    #[cfg(test)]
    pub fn blocked(&self) -> bool {
        self.verdict == Some(Severity::Block)
    }
}

/// Site limits (setting `gcode_limits`); unset fields take the defaults.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Limits {
    /// Longest single dwell (`G4`, `M400 S`) without review, seconds.
    pub max_dwell_sec: f64,
    /// Longest a heater may stay on with nothing extruded, seconds.
    pub max_heated_idle_sec: f64,
    /// How far past a material's hottest profile a nozzle may go, °C.
    pub nozzle_margin_c: f64,
    /// The same for the plate.
    pub bed_margin_c: f64,
    /// How far past the vendor's own moves the nozzle may go, mm.
    pub reach_margin_mm: f64,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            max_dwell_sec: 15.0 * 60.0,
            max_heated_idle_sec: 45.0 * 60.0,
            nozzle_margin_c: 10.0,
            bed_margin_c: 10.0,
            reach_margin_mm: 5.0,
        }
    }
}

impl Limits {
    pub fn validate(&self) -> Result<(), String> {
        let ok = |v: f64, lo: f64, hi: f64| v.is_finite() && v >= lo && v <= hi;
        if !ok(self.max_dwell_sec, 1.0, 86_400.0) || !ok(self.max_heated_idle_sec, 60.0, 86_400.0) {
            return Err("gcode_limits: dwell and idle limits must be between a second/minute and a day".into());
        }
        if !ok(self.nozzle_margin_c, 0.0, 50.0) || !ok(self.bed_margin_c, 0.0, 50.0) || !ok(self.reach_margin_mm, 0.0, 50.0) {
            return Err("gcode_limits: margins must be between 0 and 50".into());
        }
        Ok(())
    }
}

/// What the package says about the plate (trusted only for what to compare
/// against, never to excuse anything).
#[derive(Debug, Clone, Default)]
pub struct Declared {
    /// Bambu model id the plate was sliced for.
    pub model_id: Option<String>,
    /// Material per filament (index = filament id - 1); empty = unknown.
    pub materials: Vec<String>,
    /// g/cm³ per filament; missing = 1.24.
    pub densities: Vec<f64>,
    /// mm.
    pub filament_diameter: f64,
    /// For firmware other than Bambu's (plain G-code: Klipper, Marlin,
    /// Prusa, ...). The lexer reads Bambu's syntax; a line it can't read
    /// may be ordinary for that firmware (`PRINT_START BED=60`,
    /// `M117 Homing`, `M862.3 P "MK4S"`), so it needs review instead of
    /// blocking the plate.
    pub other_firmware: bool,
}

/// Longest command (the part before any `;`) we accept: Bambu's longest is
/// well under 100 characters.
const LONGEST_COMMAND: usize = 256;
/// Nozzle/plate targets at or below this count as "off" for idle checks.
const WARM_C: f64 = 50.0;

struct Ctx<'a> {
    data: &'a Data,
    model: Option<&'a ModelLimits>,
    limits: &'a Limits,
    declared: &'a Declared,
    /// Hottest nozzle/plate any declared material is printed at, + margin.
    nozzle_cap: f64,
    bed_cap: f64,
    chamber_cap: f64,
}

#[derive(Default)]
struct Findings {
    by_key: BTreeMap<(Severity, String, String), (u64, u64)>,
    order: Vec<(Severity, String, String)>,
}

impl Findings {
    fn add(&mut self, severity: Severity, code: &str, message: String, line: u64) {
        let key = (severity, code.to_string(), message);
        match self.by_key.get_mut(&key) {
            Some((_, n)) => *n += 1,
            None => {
                self.by_key.insert(key.clone(), (line, 1));
                self.order.push(key);
            }
        }
    }

    /// At most this many distinct messages per code; the rest are counted.
    fn finish(self) -> Vec<Finding> {
        const PER_CODE: usize = 5;
        let mut per_code: BTreeMap<String, usize> = BTreeMap::new();
        let mut overflow: BTreeMap<(Severity, String), (u64, u64)> = BTreeMap::new();
        let mut out = Vec::new();
        for key in self.order {
            let (line, count) = self.by_key[&key];
            let n = per_code.entry(key.1.clone()).or_default();
            *n += 1;
            if *n <= PER_CODE {
                out.push(Finding { severity: key.0, code: key.1, message: key.2, line: Some(line), count });
            } else {
                let e = overflow.entry((key.0, key.1)).or_insert((line, 0));
                e.1 += count;
            }
        }
        for ((severity, code), (line, count)) in overflow {
            out.push(Finding {
                severity,
                message: format!("…and {count} more like that ({code})"),
                code,
                line: Some(line),
                count,
            });
        }
        out.sort_by(|a, b| b.severity.cmp(&a.severity).then(a.line.cmp(&b.line)));
        out
    }
}

/// Time model: a firmware-style planner. Moves are queued; each corner's
/// speed is limited by classic jerk (how much each axis's speed may jump),
/// then a backward and a forward pass make every speed change reachable
/// with the acceleration in force, and each move's time is its trapezoid.
struct Motion {
    feed: f64,
    accel: f64,
    speed_factor: f64,
    max_speed: [f64; 4],
    max_accel: f64,
    jerk: [f64; 3],
    queue: Vec<Block>,
}

struct Block {
    len: f64,
    /// Cruise speed, mm/s.
    v: f64,
    accel: f64,
    /// Unit direction (zero for extruder-only moves).
    dir: [f64; 3],
    /// Fastest the move may start at (corner limit).
    entry_max: f64,
    entry: f64,
}

/// Moves planned together; firmware looks ahead 16-64 moves.
const LOOKAHEAD: usize = 64;

impl Motion {
    fn new(model: Option<&ModelLimits>) -> Motion {
        let max_speed = model.and_then(|m| m.max_speed).unwrap_or([500.0, 500.0, 20.0, 30.0]);
        let max_accel = model.and_then(|m| m.max_accel).unwrap_or(20_000.0);
        Motion {
            feed: 50.0,
            accel: max_accel.min(10_000.0),
            speed_factor: 1.0,
            max_speed,
            max_accel,
            jerk: [9.0, 9.0, 3.0],
            queue: Vec::new(),
        }
    }

    /// Queue a move of `d` = [dx, dy, dz, de] mm; returns the seconds of
    /// moves whose timing is now settled.
    fn push(&mut self, d: [f64; 4]) -> f64 {
        let xyz = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
        let len = if xyz > 1e-9 { xyz } else { d[3].abs() };
        if len < 1e-9 {
            return 0.0;
        }
        let mut v = self.feed * self.speed_factor;
        for (i, di) in d.iter().enumerate() {
            if di.abs() > 1e-9 {
                // Each axis moves at v * |di| / len.
                v = v.min(self.max_speed[i] * len / di.abs());
            }
        }
        let accel = self.accel.clamp(100.0, self.max_accel);
        let dir = if xyz > 1e-9 { [d[0] / xyz, d[1] / xyz, d[2] / xyz] } else { [0.0; 3] };
        // Classic jerk: from a standstill, or around a corner, each axis's
        // speed may jump by at most its jerk.
        let jump_limit = |from: [f64; 3], to: [f64; 3]| -> f64 {
            let mut vj = f64::INFINITY;
            for i in 0..3 {
                let change = (to[i] - from[i]).abs();
                if change > 1e-9 {
                    vj = vj.min(self.jerk[i] / change);
                }
            }
            vj
        };
        let entry_max = match self.queue.last() {
            Some(prev) if xyz > 1e-9 && prev.dir != [0.0; 3] => jump_limit(prev.dir, dir).min(prev.v).min(v),
            _ if xyz > 1e-9 => jump_limit([0.0; 3], dir).min(v),
            _ => 0.0,
        };
        let mut settled = 0.0;
        if xyz <= 1e-9 {
            // Extruder-only moves stop the head.
            settled += self.stop();
        }
        self.queue.push(Block { len, v, accel, dir, entry_max, entry: 0.0 });
        if xyz <= 1e-9 {
            settled += self.stop();
        } else if self.queue.len() >= 2 * LOOKAHEAD {
            settled += self.plan(LOOKAHEAD);
        }
        settled
    }

    /// Plan the queue ending at a standstill and settle all but the last
    /// `keep` moves; returns their time.
    fn plan(&mut self, keep: usize) -> f64 {
        let q = &mut self.queue;
        let n = q.len();
        if n == 0 {
            return 0.0;
        }
        // Backward: each move must be able to slow down to the next's entry.
        let mut next_entry = 0.0f64;
        for b in q.iter_mut().rev() {
            b.entry = b.entry_max.min((next_entry * next_entry + 2.0 * b.accel * b.len).sqrt());
            next_entry = b.entry;
        }
        // Forward: and to speed up from its own entry to the next's.
        for i in 1..n {
            let (a, b) = q.split_at_mut(i);
            let prev = &a[i - 1];
            let reachable = (prev.entry * prev.entry + 2.0 * prev.accel * prev.len).sqrt();
            b[0].entry = b[0].entry.min(reachable);
        }
        let settle = n.saturating_sub(keep);
        let mut t = 0.0;
        for i in 0..settle {
            let exit = if i + 1 < n { q[i + 1].entry } else { 0.0 };
            t += trapezoid(&q[i], exit);
        }
        q.drain(..settle);
        if let Some(first) = q.first_mut() {
            // The kept moves start where the settled ones left off.
            first.entry_max = first.entry;
        }
        t
    }

    /// Everything stops (a dwell, homing, a wait): settle the queue.
    fn stop(&mut self) -> f64 {
        self.plan(0)
    }
}

/// Seconds for a move from `b.entry` to `exit`, cruising at most at `b.v`.
fn trapezoid(b: &Block, exit: f64) -> f64 {
    let (v0, v1, a, d) = (b.entry, exit, b.accel, b.len);
    // Peak speed if it only accelerated then decelerated.
    let peak = ((2.0 * a * d + v0 * v0 + v1 * v1) / 2.0).sqrt();
    if peak <= b.v {
        (peak - v0).max(0.0) / a + (peak - v1).max(0.0) / a
    } else {
        let accel_d = (b.v * b.v - v0 * v0) / (2.0 * a);
        let decel_d = (b.v * b.v - v1 * v1) / (2.0 * a);
        (b.v - v0) / a + (b.v - v1) / a + (d - accel_d - decel_d).max(0.0) / b.v
    }
}

/// A heater and how long it's been on without anything extruded.
#[derive(Default)]
struct Heater {
    target: f64,
    idle_since: Option<f64>,
}

struct Sim<'a> {
    ctx: Ctx<'a>,
    f: Findings,
    stats: Stats,
    line_no: u64,
    absolute: bool,
    e_relative: bool,
    /// X, Y, Z; None = unknown (after homing, probing, levelling).
    pos: [Option<f64>; 3],
    /// How far Z has been moved down, relatively, since it became unknown.
    z_drop_unknown: f64,
    e_pos: f64,
    tool: u32,
    motion: Motion,
    nozzle: Heater,
    bed: Heater,
    now: f64,
}

impl<'a> Sim<'a> {
    fn new(ctx: Ctx<'a>) -> Sim<'a> {
        let motion = Motion::new(ctx.model);
        Sim {
            ctx,
            f: Findings::default(),
            stats: Stats::default(),
            line_no: 0,
            absolute: true,
            e_relative: false,
            pos: [None; 3],
            z_drop_unknown: 0.0,
            e_pos: 0.0,
            tool: 0,
            motion,
            nozzle: Heater::default(),
            bed: Heater::default(),
            now: 0.0,
        }
    }

    fn review(&mut self, code: &str, msg: String) {
        self.f.add(Severity::Review, code, msg, self.line_no);
    }

    fn block(&mut self, code: &str, msg: String) {
        self.f.add(Severity::Block, code, msg, self.line_no);
    }

    fn info(&mut self, code: &str, msg: String) {
        self.f.add(Severity::Info, code, msg, self.line_no);
    }

    /// Advance the clock, checking heaters left on with nothing extruded.
    fn pass(&mut self, secs: f64) {
        self.now += secs.max(0.0);
        for (name, h) in [("nozzle", &self.nozzle), ("plate", &self.bed)] {
            if let Some(since) = h.idle_since {
                let idle = self.now - since;
                if idle > self.stats.longest_heated_idle_sec {
                    self.stats.longest_heated_idle_sec = idle;
                }
                if idle > self.ctx.limits.max_heated_idle_sec {
                    let msg = format!(
                        "keeps the {name} at {:.0} °C for {} without printing anything",
                        h.target,
                        minutes(idle)
                    );
                    self.f.add(Severity::Review, "heated_idle", msg, self.line_no);
                }
            }
        }
        if self.nozzle.idle_since.is_some_and(|s| self.now - s > self.ctx.limits.max_heated_idle_sec) {
            self.nozzle.idle_since = Some(self.now);
        }
        if self.bed.idle_since.is_some_and(|s| self.now - s > self.ctx.limits.max_heated_idle_sec) {
            self.bed.idle_since = Some(self.now);
        }
    }

    fn extruded(&mut self) {
        let now = self.now;
        for h in [&mut self.nozzle, &mut self.bed] {
            if h.target > WARM_C {
                h.idle_since = Some(now);
            }
        }
    }

    fn set_heater(&mut self, which: u8, target: f64) {
        let now = self.now;
        let h = if which == b'N' { &mut self.nozzle } else { &mut self.bed };
        let was_warm = h.target > WARM_C;
        h.target = target;
        if target <= WARM_C {
            h.idle_since = None;
        } else if !was_warm {
            h.idle_since = Some(now);
        }
    }

    fn dwell(&mut self, secs: f64, what: &str) {
        if secs > self.stats.longest_dwell_sec {
            self.stats.longest_dwell_sec = secs;
        }
        if secs > self.ctx.limits.max_dwell_sec {
            self.review("long_dwell", format!("{what} waits {} in one go", minutes(secs)));
        }
        let t = self.motion.stop();
        self.pass(t + secs);
    }

    /// One physical line. A carriage return also ends a line here: firmware
    /// that treats a lone `\r` as a line break would otherwise run
    /// `; note\rG1 Z-5` as a move we never saw.
    fn physical_line(&mut self, raw: &[u8]) {
        self.line_no += 1;
        self.stats.lines += 1;
        if raw.contains(&0) {
            // C firmware may end the line at the NUL and read on as a new one.
            self.block("not_text", "has NUL bytes".to_string());
            return;
        }
        for part in raw.split(|&b| b == b'\r') {
            self.line(part);
        }
    }

    fn line(&mut self, raw: &[u8]) {
        // Only the command part matters to the printer; comments can be long
        // (Bambu Studio writes 20 kB settings lines) and in any encoding.
        let code = match raw.iter().position(|&b| b == b';') {
            Some(i) => &raw[..i],
            None => raw,
        };
        if code.len() > LONGEST_COMMAND {
            self.block("long_line", format!("has a command of {} characters", code.len()));
            return;
        }
        if !code.is_ascii() {
            self.block("not_text", "has a command with characters that aren't plain ASCII".to_string());
            return;
        }
        let text = std::str::from_utf8(code).expect("ASCII is UTF-8");
        let data = self.ctx.data;
        match lex::lex(text, |c| data.is_text(c), false) {
            Lexed::Empty => {}
            Lexed::Unreadable(why) if self.ctx.declared.other_firmware => {
                self.review("unreadable", format!("has a line FarmSlicer can't check ({why})"))
            }
            Lexed::Unreadable(why) => self.block("unreadable", format!("has a line a printer may read differently ({why})")),
            Lexed::Command(c) => {
                self.stats.commands += 1;
                self.allowed(&c);
                self.run(&c);
            }
        }
    }

    /// Is the command (and each word) something Bambu's G-code uses?
    fn allowed(&mut self, c: &Command<'_>) {
        let key = c.code.key();
        let Some(rule) = self.ctx.data.commands.get(&key) else {
            self.review("unknown_command", format!("uses {}, which Bambu's own G-code never does", c.code));
            return;
        };
        if c.code.letter == b'T' && !(rule.tools.contains(&c.code.number) || (rule.any_tool && c.code.number < 64)) {
            self.review("unknown_tool", format!("selects tool T{}, which Bambu's own G-code never does", c.code.number));
        }
        if c.code.letter != b'T' && c.words.is_empty() && c.text.is_none() && !rule.bare {
            self.review("bare_command", format!("uses {} on its own, which Bambu's own G-code never does", c.code));
        }
        if let Some(text) = c.text {
            if !rule.any_text {
                let sub = c.subcommand().unwrap_or("");
                if !rule.subcommands.contains(sub) {
                    self.review("unknown_command", format!("uses {} {sub:?}, which Bambu's own G-code never does", c.code));
                } else if text.len() > 200 {
                    self.review("unknown_command", format!("passes {} a {}-character argument", c.code, text.len()));
                }
            }
            return;
        }
        for w in &c.words {
            let letter = (w.letter as char).to_string();
            match rule.words.get(&letter) {
                None => self.review(
                    "unknown_argument",
                    format!("uses {} with {letter}, which Bambu's own G-code never does", c.code),
                ),
                Some(r) if !r.allows(w.value) => {
                    let shown = match w.value {
                        Value::Num(n) => format!("{letter}{}", trim(n)),
                        _ => letter.clone(),
                    };
                    let seen = match (r.min, r.max, r.flag) {
                        (Some(lo), Some(hi), _) if lo == hi => format!("only {letter}{}", trim(lo)),
                        (Some(lo), Some(hi), _) => format!("{letter}{}..{}", trim(lo), trim(hi)),
                        (None, None, true) => format!("{letter} on its own"),
                        _ => "other values".to_string(),
                    };
                    self.review("unusual_value", format!("uses {} {shown}; Bambu's own G-code uses {seen}", c.code));
                }
                Some(_) => {}
            }
        }
    }

    fn run(&mut self, c: &Command<'_>) {
        let code = c.code;
        match (code.letter, code.number, code.sub) {
            (b'G', 0..=3, None) => self.motion_cmd(c),
            (b'G', 4, None) => {
                let secs = c.num(b'P').map(|p| p / 1000.0).or(c.num(b'S')).unwrap_or(0.0);
                self.dwell(secs, "a pause (G4)");
            }
            (b'G', 28, _) => {
                let all = !(c.has(b'X') || c.has(b'Y') || c.has(b'Z'));
                if all || c.has(b'X') || c.has(b'Y') {
                    self.pos[0] = None;
                    self.pos[1] = None;
                }
                if all || c.has(b'Z') {
                    self.pos[2] = None;
                    self.z_drop_unknown = 0.0;
                }
                let settled = self.motion.stop();
                self.pass(settled);
            }
            // Probing and levelling: the printer decides where it ends up.
            (b'G', 29, _) | (b'G', 380, _) | (b'G', 383, _) | (b'G', 39, _) => {
                if code.number != 380 || c.has(b'Z') {
                    self.pos[2] = None;
                    self.z_drop_unknown = 0.0;
                }
                if code.number == 29 && code.sub.is_none() {
                    self.pos[0] = None;
                    self.pos[1] = None;
                }
                let settled = self.motion.stop();
                self.pass(settled);
            }
            (b'G', 90, None) => self.absolute = true,
            (b'G', 91, None) => self.absolute = false,
            (b'G', 92, None) => {
                if let Some(e) = c.num(b'E') {
                    self.e_pos = e;
                }
                for (i, l) in [b'X', b'Y', b'Z'].into_iter().enumerate() {
                    if c.has(l) {
                        self.pos[i] = c.num(l);
                    }
                }
            }
            (b'M', 82, None) => self.e_relative = false,
            (b'M', 83, None) => self.e_relative = true,
            (b'M', 104 | 109, None) => {
                if let Some(s) = c.num(b'S') {
                    self.nozzle_temp(s);
                    if code.number == 109 {
                        // Rough heating time: 2 °C/s.
                        let rise = (s - self.nozzle.target.max(25.0)).max(0.0);
                        let settled = self.motion.stop();
                        self.pass(settled);
                        self.pass(rise / 2.0);
                    }
                    self.set_heater(b'N', s);
                }
            }
            (b'M', 140 | 190, None) => {
                if let Some(s) = c.num(b'S') {
                    self.bed_temp(s);
                    if code.number == 190 {
                        let rise = (s - self.bed.target.max(25.0)).max(0.0);
                        let settled = self.motion.stop();
                        self.pass(settled);
                        self.pass(rise / 0.5);
                    }
                    self.set_heater(b'B', s);
                }
            }
            (b'M', 141 | 191, None) => {
                if let Some(s) = c.num(b'S') {
                    self.stats.max_chamber_c = self.stats.max_chamber_c.max(s);
                    if s > self.ctx.chamber_cap {
                        self.review("hot_chamber", format!("heats the chamber to {} °C", trim(s)));
                    }
                }
            }
            (b'M', 204, None) => {
                if let Some(s) = c.num(b'S') {
                    self.motion.accel = s;
                }
            }
            (b'M', 220, None) => {
                if let Some(s) = c.num(b'S') {
                    self.motion.speed_factor = (s / 100.0).clamp(0.1, 10.0);
                }
            }
            (b'M', 400, None) => {
                if c.has(b'U') {
                    self.info("waits_for_user", "pauses until someone resumes it on the printer".to_string());
                } else if let Some(secs) = c.num(b'S').or(c.num(b'P').map(|p| p / 1000.0)) {
                    self.dwell(secs, "a wait (M400)");
                }
                let settled = self.motion.stop();
                self.pass(settled);
            }
            (b'T', n, _) => {
                if n < 64 {
                    self.tool = n;
                }
            }
            _ => {}
        }
    }

    fn nozzle_temp(&mut self, s: f64) {
        self.stats.max_nozzle_c = self.stats.max_nozzle_c.max(s);
        if s > self.ctx.nozzle_cap {
            let materials = self.materials_text();
            self.review(
                "hot_nozzle",
                format!("heats the nozzle to {} °C{materials}", trim(s)),
            );
        }
    }

    fn bed_temp(&mut self, s: f64) {
        self.stats.max_bed_c = self.stats.max_bed_c.max(s);
        if s > self.ctx.bed_cap {
            let materials = self.materials_text();
            self.review("hot_plate", format!("heats the plate to {} °C{materials}", trim(s)));
        }
    }

    fn materials_text(&self) -> String {
        let known: Vec<String> = self
            .ctx
            .declared
            .materials
            .iter()
            .filter_map(|m| self.ctx.data.material(m).map(|l| format!("{m} up to {} °C", trim(l.nozzle_max))))
            .collect();
        if known.is_empty() { String::new() } else { format!(" ({})", known.join(", ")) }
    }

    fn motion_cmd(&mut self, c: &Command<'_>) {
        let before = self.pos;
        let mut target = self.pos;
        let mut delta = [0.0f64; 4];
        for (i, l) in [b'X', b'Y', b'Z'].into_iter().enumerate() {
            if let Some(v) = c.num(l) {
                if self.absolute {
                    if let Some(p) = before[i] {
                        delta[i] = v - p;
                    }
                    target[i] = Some(v);
                } else {
                    delta[i] = v;
                    target[i] = before[i].map(|p| p + v);
                    if i == 2 && before[2].is_none() {
                        self.z_drop_unknown += v;
                        if self.z_drop_unknown < -5.0 {
                            self.review(
                                "blind_z",
                                format!("moves the nozzle {} mm down from a height it hasn't measured", trim(-self.z_drop_unknown)),
                            );
                        }
                    }
                }
            }
        }
        if let Some(f) = c.num(b'F') {
            if f > 0.0 {
                self.motion.feed = f / 60.0;
            }
        }
        if let Some(e) = c.num(b'E') {
            let de = if self.e_relative { e } else { e - self.e_pos };
            self.e_pos = if self.e_relative { self.e_pos + e } else { e };
            delta[3] = de;
            if de > 0.0 {
                *self.stats.filament_mm.entry(self.tool).or_default() += de;
            }
        }

        // Arcs: length along the arc, and its extremes for the bounds.
        let is_arc = c.code.number == 2 || c.code.number == 3;
        let mut extremes: Vec<(f64, f64)> = Vec::new();
        if is_arc {
            if let ([Some(x0), Some(y0), _], [Some(x1), Some(y1), _]) = (before, target) {
                let (i, j) = (c.num(b'I').unwrap_or(0.0), c.num(b'J').unwrap_or(0.0));
                let (cx, cy) = (x0 + i, y0 + j);
                let r = (i * i + j * j).sqrt();
                let a0 = (y0 - cy).atan2(x0 - cx);
                let mut a1 = (y1 - cy).atan2(x1 - cx);
                let cw = c.code.number == 2;
                let tau = std::f64::consts::TAU;
                if cw {
                    while a1 >= a0 {
                        a1 -= tau;
                    }
                } else {
                    while a1 <= a0 {
                        a1 += tau;
                    }
                }
                let sweep = (a1 - a0).abs();
                let arc_len = r * sweep;
                let planar = (delta[0] * delta[0] + delta[1] * delta[1]).sqrt();
                if planar > 1e-9 {
                    let scale = arc_len / planar;
                    delta[0] *= scale;
                    delta[1] *= scale;
                } else {
                    delta[0] = arc_len;
                }
                for k in 0..4 {
                    let a = k as f64 * std::f64::consts::FRAC_PI_2;
                    let inside = |a: f64| {
                        let (lo, hi) = if cw { (a1, a0) } else { (a0, a1) };
                        let mut t = a;
                        while t < lo {
                            t += tau;
                        }
                        while t > hi {
                            t -= tau;
                        }
                        t >= lo && t <= hi
                    };
                    if inside(a) {
                        extremes.push((cx + r * a.cos(), cy + r * a.sin()));
                    }
                }
            }
        }

        let t = self.motion.push(delta);
        self.pass(t);
        if delta[3] > 0.0 {
            self.extruded();
        }
        self.pos = target;
        if let [Some(x), Some(y), _] = target {
            self.bounds(x, y, target[2]);
            for (ex, ey) in extremes {
                self.bounds(ex, ey, target[2]);
            }
        } else if let Some(z) = target[2] {
            self.z_bounds(None, z);
        }
    }

    fn bounds(&mut self, x: f64, y: f64, z: Option<f64>) {
        if let Some(m) = self.ctx.model {
            let margin = self.ctx.limits.reach_margin_mm;
            let mut env = m.bed;
            if let (Some(e), Some(r)) = (env.as_mut(), m.reach) {
                e[0] = e[0].min(r[0]);
                e[1] = e[1].min(r[1]);
                e[2] = e[2].max(r[2]);
                e[3] = e[3].max(r[3]);
            }
            if let Some(e) = env {
                if x < e[0] - margin || y < e[1] - margin || x > e[2] + margin || y > e[3] + margin {
                    self.review(
                        "out_of_reach",
                        format!("moves to X{} Y{}, outside where the printer's own G-code goes", trim1(x), trim1(y)),
                    );
                }
            }
        }
        if let Some(z) = z {
            self.z_bounds(Some((x, y)), z);
        }
    }

    fn z_bounds(&mut self, xy: Option<(f64, f64)>, z: f64) {
        let Some(m) = self.ctx.model else { return };
        if let Some(max_z) = m.max_z {
            if z > max_z + 5.0 {
                self.review("out_of_reach", format!("raises the nozzle to Z{}, above the {} mm build height", trim1(z), trim(max_z)));
            }
        }
        if z < -0.05 {
            let margin = self.ctx.limits.reach_margin_mm;
            let allowed_here = match (xy, m.below_plate) {
                (Some((x, y)), Some(b)) => x >= b[0] - margin && x <= b[2] + margin && y >= b[1] - margin && y <= b[3] + margin,
                _ => false,
            };
            let deep_enough = m.min_z.is_some_and(|min| z >= min - 0.1);
            if !(allowed_here && deep_enough) {
                let at = xy.map(|(x, y)| format!(" at X{} Y{}", trim1(x), trim1(y))).unwrap_or_default();
                self.review("below_plate", format!("pushes the nozzle {} mm below the plate{at}", trim(-z)));
            }
        }
    }

    fn finish(mut self) -> PlateCheck {
        let settled = self.motion.stop();
        self.pass(settled);
        let d = self.ctx.declared;
        let diameter = if d.filament_diameter > 0.5 && d.filament_diameter < 5.0 { d.filament_diameter } else { 1.75 };
        let area = std::f64::consts::PI * diameter * diameter / 4.0;
        for (&tool, &mm) in &self.stats.filament_mm {
            let density = d.densities.get(tool as usize).copied().filter(|x| *x > 0.5 && *x < 3.0).unwrap_or(1.24);
            self.stats.filament_g.insert(tool, mm * area * density / 1000.0);
            if !d.materials.is_empty() && tool as usize >= d.materials.len() {
                self.f.add(
                    Severity::Review,
                    "undeclared_filament",
                    format!("prints with filament {} but the project lists {}", tool + 1, d.materials.len()),
                    0,
                );
            }
        }
        self.stats.time_sec = self.now;
        let findings = self.f.finish();
        PlateCheck {
            checker: String::new(),
            verdict: findings.iter().map(|f| f.severity).max(),
            findings,
            time_sec: self.stats.time_sec,
            grams: self.stats.total_g(),
            filament_g: self.stats.filament_g.iter().map(|(t, g)| (t + 1, *g)).collect(),
            stats: self.stats,
        }
    }
}

fn trim(n: f64) -> String {
    let s = format!("{n:.3}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s == "-0" { "0".into() } else { s.to_string() }
}

fn trim1(n: f64) -> String {
    trim((n * 10.0).round() / 10.0)
}

pub fn minutes(secs: f64) -> String {
    let m = (secs / 60.0).round() as u64;
    match (m / 60, m % 60) {
        (0, m) => format!("{m} min"),
        (h, 0) => format!("{h} h"),
        (h, m) => format!("{h} h {m} min"),
    }
}

/// Check one plate's G-code.
pub fn check<R: BufRead>(mut reader: R, data: &Data, declared: &Declared, limits: &Limits) -> std::io::Result<PlateCheck> {
    let model = declared.model_id.as_deref().and_then(|id| data.model(id));
    let mut nozzle_cap = model.and_then(|m| m.nozzle_max).unwrap_or(300.0);
    let mut bed_cap = model.and_then(|m| m.bed_max).unwrap_or(110.0);
    let materials: Vec<_> = declared.materials.iter().filter_map(|m| data.material(m)).collect();
    if !materials.is_empty() && materials.len() == declared.materials.iter().filter(|m| !m.trim().is_empty()).count() {
        let hottest = materials.iter().map(|m| m.nozzle_max).fold(0.0, f64::max) + limits.nozzle_margin_c;
        let warmest = materials.iter().map(|m| m.bed_max).fold(0.0, f64::max) + limits.bed_margin_c;
        // The vendor's own sequences may go hotter than the material (a
        // common flush temperature), never past the model's maximum.
        let vendor_nozzle = model.and_then(|m| m.template_nozzle_max).unwrap_or(0.0);
        let vendor_bed = model.and_then(|m| m.template_bed_max).unwrap_or(0.0);
        nozzle_cap = nozzle_cap.min(hottest.max(vendor_nozzle));
        bed_cap = bed_cap.min(warmest.max(vendor_bed));
    }
    let ctx = Ctx {
        data,
        model,
        limits,
        declared,
        nozzle_cap,
        bed_cap,
        chamber_cap: model.and_then(|m| m.chamber_max).unwrap_or(65.0),
    };
    let mut sim = Sim::new(ctx);
    match &declared.model_id {
        None => sim.review("unknown_model", "doesn't say which printer model it's for, so where it moves can't be checked".to_string()),
        Some(id) if model.is_none() => {
            sim.review("unknown_model", format!("is for printer model {id}, which FarmSlicer has no data for"))
        }
        _ => {}
    }
    for m in &declared.materials {
        if !m.trim().is_empty() && data.material(m).is_none() {
            sim.info("unknown_material", format!("uses {m}, a material FarmSlicer has no temperatures for"));
        }
    }
    let mut buf = Vec::with_capacity(256);
    loop {
        buf.clear();
        let n = reader.read_until(b'\n', &mut buf)?;
        if n == 0 {
            break;
        }
        if buf.last() == Some(&b'\n') {
            buf.pop();
        }
        sim.physical_line(&buf);
    }
    Ok(sim.finish())
}

/// Shorthand for tests with G-code in memory.
#[cfg(test)]
pub fn check_str(gcode: &str, data: &Data, declared: &Declared, limits: &Limits) -> PlateCheck {
    check(gcode.as_bytes(), data, declared, limits).expect("in-memory reads don't fail")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gcode::data::data;

    fn x1(materials: &[&str]) -> Declared {
        Declared {
            model_id: Some("BL-P001".into()),
            materials: materials.iter().map(|s| s.to_string()).collect(),
            densities: vec![1.24; materials.len()],
            filament_diameter: 1.75,
            other_firmware: false,
        }
    }

    fn run(g: &str) -> PlateCheck {
        check_str(g, data(), &x1(&["PLA"]), &Limits::default())
    }

    fn codes(c: &PlateCheck) -> Vec<&str> {
        c.findings.iter().map(|f| f.code.as_str()).collect()
    }

    const OK: &str = "G90\nM83\nM104 S220\nM140 S55\nG28\nG1 X10 Y10 Z0.2 F12000\nG1 X100 Y10 E5 F3000\nG2 X110 Y20 I0 J10 E1\nM106 S255\nM73 P50 R10\nG1 Z10\nM104 S0\nM140 S0\n";

    #[test]
    fn an_ordinary_print_is_clean() {
        let c = run(OK);
        assert_eq!(c.verdict, None, "{:?}", c.findings);
        assert!((c.stats.filament_mm[&0] - 6.0).abs() < 1e-9);
        assert!(c.stats.time_sec > 0.0);
        assert_eq!(c.stats.max_nozzle_c, 220.0);
    }

    #[test]
    fn temperatures_follow_the_material() {
        let c = run("M104 S300\nM140 S110\n");
        assert_eq!(codes(&c), vec!["hot_nozzle", "hot_plate"], "{:?}", c.findings);
        assert!(c.findings[0].message.contains("PLA up to"), "{}", c.findings[0].message);
        let petg = check_str("M104 S280\nM140 S80\n", data(), &x1(&["PETG"]), &Limits::default());
        assert_eq!(petg.verdict, None, "{:?}", petg.findings);
    }

    #[test]
    fn unknown_commands_and_values_need_review() {
        let c = run("M221\nM221 S500\nM999\nM1002 format_disk\nM104 Q1\nM500 R\nM500\n");
        let has = |code: &str, text: &str| c.findings.iter().any(|f| f.code == code && f.message.contains(text));
        assert!(has("bare_command", "M221 on its own"), "{:?}", c.findings);
        assert!(has("unusual_value", "M221 S500"), "{:?}", c.findings);
        assert!(has("unknown_command", "M999"), "{:?}", c.findings);
        assert!(has("unknown_command", "format_disk"), "{:?}", c.findings);
        assert!(has("unknown_argument", "M104 with Q"), "{:?}", c.findings);
        // `M500 R`, and `M500` alone after levelling, are what Bambu writes.
        assert_eq!(c.findings.len(), 5, "{:?}", c.findings);
        assert!(c.needs_review() && !c.blocked());
    }

    #[test]
    fn unreadable_lines_block() {
        let c = run("G1 X10 Y10\nG1 X(1)\n");
        assert!(c.blocked(), "{:?}", c.findings);
        assert_eq!(c.findings[0].line, Some(2));
        assert!(check_str("G1 X1\u{0}\n", data(), &x1(&["PLA"]), &Limits::default()).blocked());
        assert!(run("; note \u{0} M104 S300\n").blocked(), "a NUL in a comment too");
        // A lone CR ends a line for some firmware: what follows is checked.
        let c = run("; note\rM104 S300\n");
        assert_eq!(codes(&c), vec!["hot_nozzle"], "{:?}", c.findings);
        assert_eq!(c.findings[0].line, Some(1));
        // CRLF files and long or non-ASCII comments are fine.
        let long = format!("; {}\r\nG1 X1 ; café\r\n", "x".repeat(30_000));
        assert_eq!(run(&long).verdict, None);
        assert!(run(&format!("G1 X1 {}\n", "Y1 ".repeat(100))).blocked(), "long commands");
        assert!(run("G1 X1 Y\u{e9}\n").blocked(), "non-ASCII commands");
    }

    #[test]
    fn other_firmware_lines_need_review() {
        let other = Declared { model_id: Some("Voron 2.4 350".into()), other_firmware: true, ..x1(&["PLA"]) };
        let run = |g: &str| check_str(g, data(), &other, &Limits::default());
        let c = run("PRINT_START BED=60\nM117 Homing\nM862.3 P \"MK4S\"\nG1 X10\n");
        assert!(!c.blocked(), "{:?}", c.findings);
        assert_eq!(codes(&c).iter().filter(|&&k| k == "unreadable").count(), 3, "{:?}", c.findings);
        assert!(c.needs_review());
        // What no firmware reads the same way still blocks.
        assert!(run(&format!("G1 X1 {}\n", "Y1 ".repeat(100))).blocked(), "long commands");
        assert!(run("G1 X1 Y\u{e9}\n").blocked(), "non-ASCII commands");
    }

    #[test]
    fn long_dwells_and_idle_heaters() {
        let c = run("M104 S220\nG4 S3600\n");
        assert!(codes(&c).contains(&"long_dwell") && codes(&c).contains(&"heated_idle"), "{:?}", c.findings);
        assert!((c.stats.time_sec - 3600.0).abs() < 1.0, "{}", c.stats.time_sec);
        let c = run("G4 S600\nM400 S120\n");
        assert_eq!(c.verdict, None, "{:?}", c.findings);
    }

    #[test]
    fn the_nozzle_stays_where_bambu_takes_it() {
        let c = run("G90\nG28\nG1 X10 Y10 Z5\nG1 X600 Y10\n");
        assert_eq!(codes(&c), vec!["out_of_reach"], "{:?}", c.findings);
        let c = run("G90\nG1 X128 Y128 Z5\nG1 Z-1\n");
        assert_eq!(codes(&c), vec!["below_plate"], "{:?}", c.findings);
        // Behind the plate, on the steel the wipe uses: fine.
        let c = run("G90\nG1 X128 Y261 Z-1.5\n");
        assert_eq!(c.verdict, None, "{:?}", c.findings);
        // Relative moves from an unmeasured height.
        let c = run("G28\nG91\nG1 Z-3\nG1 Z-3\n");
        assert_eq!(codes(&c), vec!["blind_z"], "{:?}", c.findings);
        // Arcs bulge: the extreme of this one is at X300.
        let c = run("G90\nG1 X200 Y100 Z1\nG3 X200 Y100.001 I50 J0\n");
        assert!(codes(&c).contains(&"out_of_reach"), "{:?}", c.findings);
    }

    #[test]
    fn filament_is_counted_per_tool() {
        let c = run("M83\nT0\nG1 X1 E10\nT1\nG1 X2 E5\nG1 X3 E-2\n");
        assert_eq!(c.stats.filament_mm[&0], 10.0);
        assert_eq!(c.stats.filament_mm[&1], 5.0);
        assert!(codes(&c).contains(&"undeclared_filament"), "{:?}", c.findings);
        let g = c.stats.filament_g[&0];
        assert!((g - 10.0 * std::f64::consts::PI * 1.75 * 1.75 / 4.0 * 1.24 / 1000.0).abs() < 1e-9);
        // Absolute extrusion with resets.
        let c = run("M82\nG92 E0\nG1 X1 E4\nG1 X2 E6\nG92 E0\nG1 X3 E1\n");
        assert!((c.stats.filament_mm[&0] - 7.0).abs() < 1e-9);
    }

    #[test]
    fn missing_model_is_reviewed() {
        let c = check_str("G28\n", data(), &Declared::default(), &Limits::default());
        assert_eq!(codes(&c), vec!["unknown_model"]);
    }

    #[test]
    fn findings_are_summarised() {
        let g: String = (0..50).map(|i| format!("M999 S{i}\n")).collect();
        let c = run(&g);
        assert_eq!(c.findings.len(), 1, "{:?}", c.findings);
        assert_eq!(c.findings[0].count, 50);
    }
}
