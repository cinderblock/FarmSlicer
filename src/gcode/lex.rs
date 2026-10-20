//! One line of G-code → a command and its words, read the way the printer's
//! firmware reads it: `G1X10Y20` is `G1 X10 Y20`, `M620 S0A` is `M620 S0 A`.
//!
//! A few Bambu commands take free text instead of words (`M1002 judge_flag
//! g29_before_print_flag`, `M624 AQAAAAAAAAA=`); which ones is data
//! (`text_commands`), not syntax. A few are named by a word instead of a
//! letter and number (`SYNC T5`); those are read only when the data names
//! them. Anything we can't read the same way the firmware would is reported,
//! never guessed at.

/// What vendor templates put where a value will be substituted.
pub const PLACEHOLDER: char = '\u{1}';

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Code<'a> {
    /// `G`, `M` or `T`; 0 for a named command.
    pub letter: u8,
    pub number: u32,
    /// `M620.1` → Some(1).
    pub sub: Option<u32>,
    /// A command named by a word (`SYNC`).
    pub name: Option<&'a str>,
}

impl Code<'_> {
    /// How the data names a command: `G1`, `M620.1`, `SYNC`; T commands are
    /// all `T`.
    pub fn key(&self) -> String {
        if let Some(name) = self.name {
            return name.to_string();
        }
        match (self.letter, self.sub) {
            (b'T', _) => "T".to_string(),
            (l, None) => format!("{}{}", l as char, self.number),
            (l, Some(s)) => format!("{}{}.{}", l as char, self.number, s),
        }
    }

    #[cfg(test)]
    pub fn is(&self, letter: u8, number: u32) -> bool {
        self.letter == letter && self.number == number && self.sub.is_none()
    }
}

impl std::fmt::Display for Code<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if let Some(name) = self.name {
            return f.write_str(name);
        }
        match self.sub {
            None => write!(f, "{}{}", self.letter as char, self.number),
            Some(s) => write!(f, "{}{}.{}", self.letter as char, self.number, s),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Value {
    /// A letter on its own (`G28 X`, `M220 B`).
    Flag,
    Num(f64),
    /// A template placeholder (vendor templates only).
    Templated,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Word {
    pub letter: u8,
    pub value: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Command<'a> {
    pub code: Code<'a>,
    pub words: Vec<Word>,
    /// Free-text argument of a text command, trimmed.
    pub text: Option<&'a str>,
}

impl Command<'_> {
    /// The first numeric value of `letter`.
    pub fn num(&self, letter: u8) -> Option<f64> {
        self.words.iter().find_map(|w| match w.value {
            Value::Num(n) if w.letter == letter => Some(n),
            _ => None,
        })
    }

    pub fn has(&self, letter: u8) -> bool {
        self.words.iter().any(|w| w.letter == letter)
    }

    /// The first word of a text command (`judge_flag`, `set_filament_type`).
    pub fn subcommand(&self) -> Option<&str> {
        let t = self.text?;
        let end = t.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_')).unwrap_or(t.len());
        Some(&t[..end])
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Lexed<'a> {
    /// Blank or comment only.
    Empty,
    Command(Command<'a>),
    /// Not G-code the firmware would read the way we do; the reason.
    Unreadable(String),
}

/// Lex one line (without its newline). `is_text` says which commands take
/// free text, `is_named` which words name a command; `templates` lets
/// [`PLACEHOLDER`] stand for a value.
pub fn lex<'a>(
    line: &'a str,
    is_text: impl Fn(&Code) -> bool,
    is_named: impl Fn(&str) -> bool,
    templates: bool,
) -> Lexed<'a> {
    let code_part = match line.find(';') {
        Some(i) => &line[..i],
        None => line,
    };
    let s = code_part.trim_matches(|c| c == ' ' || c == '\t' || c == '\r');
    if s.is_empty() {
        return Lexed::Empty;
    }
    let b = s.as_bytes();
    let letter = b[0];
    // A word naming a command: two or more upper-case letters, digits or
    // underscores, starting with two that aren't digits (`G1` is a letter
    // and a number).
    let name_len = b.iter().take_while(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || **c == b'_').count();
    let named = name_len >= 2
        && !b[0].is_ascii_digit()
        && (b[1].is_ascii_uppercase() || b[1] == b'_')
        && b.get(name_len).is_none_or(|c| *c == b' ' || *c == b'\t');
    if named && is_named(&s[..name_len]) {
        let code = Code { letter: 0, number: 0, sub: None, name: Some(&s[..name_len]) };
        return lex_args(s, code, &s[name_len..], is_text, templates);
    }
    if !matches!(letter, b'G' | b'M' | b'T') {
        return Lexed::Unreadable(format!("not a G, M or T command: {}", excerpt(s)));
    }
    let mut i = 1;
    let start = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    let mut number: Option<u32> = s[start..i].parse().ok();
    if letter == b'T' && templates && b.get(i) == Some(&(PLACEHOLDER as u8)) && i == start {
        // `T[next_extruder]`: any tool.
        i += 1;
        number = Some(u32::MAX);
    }
    let Some(number) = number else {
        return Lexed::Unreadable(format!("a command without a number: {}", excerpt(s)));
    };
    let mut sub = None;
    if letter != b'T' && b.get(i) == Some(&b'.') && b.get(i + 1).is_some_and(u8::is_ascii_digit) {
        let st = i + 1;
        i += 1;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        sub = s[st..i].parse().ok();
    }
    let code = Code { letter, number, sub, name: None };
    let rest = &s[i..];
    if !rest.is_empty() && !rest.starts_with([' ', '\t']) && !rest.as_bytes()[0].is_ascii_uppercase() {
        return Lexed::Unreadable(format!("unexpected text after {code}: {}", excerpt(s)));
    }
    lex_args(s, code, rest, is_text, templates)
}

/// The rest of a command line after its code: free text or words.
fn lex_args<'a>(s: &'a str, code: Code<'a>, rest: &'a str, is_text: impl Fn(&Code) -> bool, templates: bool) -> Lexed<'a> {
    if is_text(&code) {
        let text = rest.trim_matches(|c| c == ' ' || c == '\t');
        if text.chars().any(|c| c.is_control() && !(templates && c == PLACEHOLDER)) {
            return Lexed::Unreadable(format!("control characters in {code}"));
        }
        return Lexed::Command(Command { code, words: Vec::new(), text: Some(text) });
    }

    let mut words = Vec::new();
    let r = rest.as_bytes();
    let mut j = 0;
    while j < r.len() {
        let c = r[j];
        if c == b' ' || c == b'\t' {
            j += 1;
            continue;
        }
        if !c.is_ascii_uppercase() {
            return Lexed::Unreadable(format!("an argument FarmSlicer can't parse: {}", excerpt(s)));
        }
        j += 1;
        let vs = j;
        while j < r.len() && (r[j].is_ascii_digit() || matches!(r[j], b'.' | b'-' | b'+') || (templates && r[j] == PLACEHOLDER as u8)) {
            j += 1;
        }
        let raw = &rest[vs..j];
        let value = if raw.is_empty() {
            Value::Flag
        } else if raw.contains(PLACEHOLDER) {
            Value::Templated
        } else {
            match parse_number(raw) {
                Some(n) => Value::Num(n),
                None => return Lexed::Unreadable(format!("a malformed number in {code}: {raw:?}")),
            }
        };
        words.push(Word { letter: c, value });
    }
    Lexed::Command(Command { code, words, text: None })
}

/// A Klipper-style extended command: `SET_HEATER_TEMPERATURE HEATER=extruder
/// TARGET=220`, or a macro the printer's config defines (`PRINT_START
/// BED=60`). Names and keys upper case, as Klipper matches them.
#[derive(Debug, Clone, PartialEq)]
pub struct Extended {
    pub name: String,
    pub params: Vec<(String, String)>,
}

impl Extended {
    pub fn param(&self, key: &str) -> Option<&str> {
        self.params.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }

    pub fn num(&self, key: &str) -> Option<f64> {
        self.param(key).and_then(|v| v.trim_matches('"').parse().ok()).filter(|n: &f64| n.is_finite())
    }
}

/// A line of another firmware's G-code (Klipper, Marlin, Prusa, RepRap).
#[derive(Debug, Clone, PartialEq)]
pub enum Other<'a> {
    Empty,
    Command(Command<'a>),
    Extended(Extended),
    /// Neither: the reason.
    Unreadable(String),
}

/// Commands other firmware takes free text with: stops and messages (`M0`,
/// `M117 Homing`), file names (`M23`, `M28`-`M33`), macros (`M98
/// P"start.g"`), version and model checks (`M115 U6.1.3`, `M862.3 P
/// "MK4S"`), object labels (`M486 S0 A"cube"`).
pub fn other_text(c: &Code) -> bool {
    c.letter == b'M' && matches!(c.number, 0 | 1 | 16 | 23 | 28 | 29 | 30 | 32 | 33 | 98 | 115 | 117 | 118 | 486 | 862)
}

/// Lex a line of another firmware's G-code. `upper` must already be upper
/// case: Klipper, Marlin and Prusa read `g1 x10` as `G1 X10`, and Klipper
/// matches extended commands and their keys case-insensitively.
pub fn lex_other(upper: &str, templates: bool) -> Other<'_> {
    let code_part = match upper.find(';') {
        Some(i) => &upper[..i],
        None => upper,
    };
    let s = code_part.trim_matches(|c| c == ' ' || c == '\t' || c == '\r');
    let b = s.as_bytes();
    match b.first() {
        None => Other::Empty,
        Some(b'G' | b'M' | b'T')
            if b.get(1).is_some_and(|c| c.is_ascii_digit() || (templates && *c == PLACEHOLDER as u8)) =>
        {
            match lex(s, other_text, |_| false, templates) {
                Lexed::Empty => Other::Empty,
                Lexed::Command(c) => Other::Command(c),
                // Klipper macros may be named like G-codes and take its
                // parameters (Anycubic's `G9111 BEDTEMP=60 EXTRUDERTEMP=220`).
                Lexed::Unreadable(_) if s.contains('=') => {
                    let name_end = s.find([' ', '\t']).unwrap_or(s.len());
                    Other::Extended(Extended { name: s[..name_end].to_string(), params: extended_params(&s[name_end..]) })
                }
                Lexed::Unreadable(why) => Other::Unreadable(why),
            }
        }
        Some(c) if c.is_ascii_uppercase() || *c == b'_' => {
            let name_end = s.find([' ', '\t']).unwrap_or(s.len());
            let name = &s[..name_end];
            if !name.bytes().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_' || (templates && c == PLACEHOLDER as u8)) {
                return Other::Unreadable(format!("not a command: {}", excerpt(s)));
            }
            Other::Extended(Extended { name: name.to_string(), params: extended_params(&s[name_end..]) })
        }
        Some(_) => Other::Unreadable(format!("not a command: {}", excerpt(s))),
    }
}

/// `KEY=VALUE` pairs, values possibly quoted; anything else is skipped.
fn extended_params(rest: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut tokens = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    for c in rest.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                cur.push(c);
            }
            ' ' | '\t' if !quoted => {
                if !cur.is_empty() {
                    tokens.push(std::mem::take(&mut cur));
                }
            }
            _ => cur.push(c),
        }
    }
    if !cur.is_empty() {
        tokens.push(cur);
    }
    for t in tokens {
        if let Some((k, v)) = t.split_once('=') {
            out.push((k.to_string(), v.trim_matches('"').to_string()));
        }
    }
    out
}

/// `-12.5`, `+3`, `.5`, `7.`: what firmware reads with strtod, minus
/// exponents, hex and the like, which no slicer writes.
fn parse_number(raw: &str) -> Option<f64> {
    let body = raw.strip_prefix(['-', '+']).unwrap_or(raw);
    if body.is_empty() || body.contains(['-', '+']) || body.matches('.').count() > 1 || body == "." {
        return None;
    }
    raw.parse::<f64>().ok().filter(|n| n.is_finite())
}

pub fn excerpt(s: &str) -> String {
    let t: String = s.chars().take(60).map(|c| if c.is_control() { '?' } else { c }).collect();
    if s.chars().count() > 60 { format!("{t}…") } else { t }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(c: &Code) -> bool {
        c.is(b'M', 1002) || c.is(b'M', 624)
    }

    fn named(name: &str) -> bool {
        name == "SYNC"
    }

    fn cmd(line: &str) -> Command<'_> {
        match lex(line, text, named, false) {
            Lexed::Command(c) => c,
            other => panic!("{line}: {other:?}"),
        }
    }

    #[test]
    fn reads_words() {
        let c = cmd("G1 X10.5 Y-3 E.25 F1200 ; move");
        assert_eq!(c.code.key(), "G1");
        assert_eq!(c.num(b'X'), Some(10.5));
        assert_eq!(c.num(b'Y'), Some(-3.0));
        assert_eq!(c.num(b'E'), Some(0.25));
        assert_eq!(c.num(b'F'), Some(1200.0));
    }

    #[test]
    fn reads_like_firmware() {
        let c = cmd("G1X10Y20");
        assert_eq!((c.num(b'X'), c.num(b'Y')), (Some(10.0), Some(20.0)));
        let c = cmd("M620 S0A");
        assert_eq!(c.code.key(), "M620");
        assert_eq!(c.words, vec![Word { letter: b'S', value: Value::Num(0.0) }, Word { letter: b'A', value: Value::Flag }]);
        let c = cmd("M620.1 E F523.843 T240");
        assert_eq!(c.code.key(), "M620.1");
        assert_eq!(c.words[0], Word { letter: b'E', value: Value::Flag });
        assert_eq!(cmd("T1000").code.number, 1000);
        assert_eq!(cmd("T1000").code.key(), "T");
        assert_eq!(cmd("G29.1 Z-0.04").code.sub, Some(1));
    }

    #[test]
    fn text_commands_keep_their_text() {
        let c = cmd("M1002 judge_flag g29_before_print_flag");
        assert_eq!(c.subcommand(), Some("judge_flag"));
        assert_eq!(c.text, Some("judge_flag g29_before_print_flag"));
        assert_eq!(cmd("M1002 gcode_claim_action:54").subcommand(), Some("gcode_claim_action"));
        assert_eq!(cmd("M624 AQAAAAAAAAA=").text, Some("AQAAAAAAAAA="));
    }

    #[test]
    fn empty_and_unreadable() {
        assert_eq!(lex("   ; just a comment", text, named, false), Lexed::Empty);
        assert_eq!(lex("", text, named, false), Lexed::Empty);
        for bad in ["X10", "g1 x10", "G1 x10", "G1 X1e3", "G1 X--1", "G1 X(1)", "M104 S200*12", "G1 X1.2.3", "N10 G1 X1", "G", "M104_S300"] {
            assert!(matches!(lex(bad, text, named, false), Lexed::Unreadable(_)), "{bad}");
        }
        assert!(matches!(lex("G1 X\u{1}", text, named, false), Lexed::Unreadable(_)), "placeholders only in templates");
    }

    #[test]
    fn named_commands_only_when_known() {
        let c = cmd("SYNC T5 ; wait");
        assert_eq!((c.code.key(), c.code.to_string(), c.num(b'T')), ("SYNC".to_string(), "SYNC".to_string(), Some(5.0)));
        assert_eq!(cmd("SYNC").words, vec![]);
        for bad in ["SYNCED T5", "FOO T5", "SYNC_ALL", "SYNCT5", "SYNC=1", "SYNC t5"] {
            assert!(matches!(lex(bad, text, named, false), Lexed::Unreadable(_)), "{bad}");
        }
        // A letter and a number is never a name.
        assert_eq!(cmd("G1 X1").code.name, None);
    }

    #[test]
    fn other_firmware() {
        let up = |s: &str| s.to_ascii_uppercase();
        let l = up("g1 x10 e.5 f1200 ; move");
        let Other::Command(c) = lex_other(&l, false) else { panic!("{l}") };
        assert_eq!((c.code.key(), c.num(b'X'), c.num(b'F')), ("G1".to_string(), Some(10.0), Some(1200.0)));
        let l = up("set_heater_temperature heater=extruder target=300");
        let Other::Extended(e) = lex_other(&l, false) else { panic!("{l}") };
        assert_eq!(e.name, "SET_HEATER_TEMPERATURE");
        assert_eq!((e.param("HEATER"), e.num("TARGET")), (Some("EXTRUDER"), Some(300.0)));
        let l = up("PRINT_START EXTRUDER=220 BED=60 MATERIAL=\"PLA Silk\"");
        let Other::Extended(e) = lex_other(&l, false) else { panic!("{l}") };
        assert_eq!((e.num("BED"), e.param("MATERIAL")), (Some(60.0), Some("PLA SILK")));
        for text in ["M117 Homing...", "M862.3 P \"MK4S\"", "M115 U6.1.3+7898", "M98 P\"start_print.g\"", "M486 S0 A\"cube\""] {
            let l = up(text);
            assert!(matches!(lex_other(&l, false), Other::Command(Command { text: Some(_), .. })), "{text}");
        }
        assert_eq!(lex_other("TIMELAPSE_TAKE_FRAME", false), Other::Extended(Extended { name: "TIMELAPSE_TAKE_FRAME".into(), params: vec![] }));
        let Other::Extended(e) = lex_other("G9111 BEDTEMP=60 EXTRUDERTEMP=220", false) else { panic!() };
        assert_eq!((e.name.as_str(), e.num("EXTRUDERTEMP")), ("G9111", Some(220.0)));
        assert_eq!(lex_other("  ; comment", false), Other::Empty);
        assert!(matches!(lex_other("G1 X(1)", false), Other::Unreadable(_)));
        assert!(matches!(lex_other("{IF}", false), Other::Unreadable(_)));
    }

    #[test]
    fn templates() {
        let Lexed::Command(c) = lex("M620 S\u{1}A", text, named, true) else { panic!() };
        assert_eq!(c.words[0].value, Value::Templated);
        assert_eq!(c.words[1].value, Value::Flag);
        let Lexed::Command(c) = lex("T\u{1}", text, named, true) else { panic!() };
        assert_eq!(c.code.number, u32::MAX);
    }
}
