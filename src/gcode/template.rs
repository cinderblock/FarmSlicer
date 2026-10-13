//! Vendor G-code templates (`machine_start_gcode` & co.) → plain lines with
//! [`PLACEHOLDER`] where the slicer substitutes a value.
//!
//! The template language (libslic3r's PlaceholderParser): `[name]` and
//! `[name[index]]` substitute a value; `{expression}` too; `{if ...}`,
//! `{elsif ...}`, `{else}`, `{endif}` choose lines. Every branch is kept:
//! whatever any branch can emit is something the vendor emits. A control
//! tag in the middle of a line ends that line, so `{if a}M106 S255{else}M106
//! S0{endif}` yields both commands.

use super::lex::PLACEHOLDER;

/// The lines a template can produce, placeholders marked.
pub fn lines(template: &str) -> Vec<String> {
    let chars: Vec<char> = template.chars().collect();
    let mut out = Vec::new();
    let mut line = String::new();
    let mut i = 0;
    let flush = |line: &mut String, out: &mut Vec<String>| {
        if !line.trim().is_empty() {
            out.push(std::mem::take(line));
        }
        line.clear();
    };
    while i < chars.len() {
        let c = chars[i];
        match c {
            '\n' => {
                flush(&mut line, &mut out);
                i += 1;
            }
            ';' => {
                // A comment runs to the end of the line; nothing in it counts.
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
            }
            '{' => {
                let end = matching(&chars, i, '{', '}');
                let inner: String = chars[i + 1..end.min(chars.len())].iter().collect();
                let word = inner.trim_start();
                let control = ["if ", "if(", "elsif", "else", "endif"]
                    .iter()
                    .any(|k| word.starts_with(k));
                if control {
                    flush(&mut line, &mut out);
                } else {
                    line.push(PLACEHOLDER);
                }
                i = end + 1;
            }
            '[' if chars.get(i + 1).is_some_and(|n| n.is_ascii_alphabetic() || *n == '_') => {
                let end = matching(&chars, i, '[', ']');
                line.push(PLACEHOLDER);
                i = end + 1;
            }
            _ => {
                line.push(c);
                i += 1;
            }
        }
    }
    flush(&mut line, &mut out);
    out
}

/// Index of the bracket closing the one at `start` (nesting and quoted
/// strings respected), or the end of the input.
fn matching(chars: &[char], start: usize, open: char, close: char) -> usize {
    let mut depth = 0;
    let mut quote = false;
    let mut i = start;
    while i < chars.len() {
        let c = chars[i];
        if quote {
            if c == '\\' {
                i += 1;
            } else if c == '"' {
                quote = false;
            }
        } else if c == '"' {
            quote = true;
        } else if c == open {
            depth += 1;
        } else if c == close {
            depth -= 1;
            if depth == 0 {
                return i;
            }
        }
        i += 1;
    }
    chars.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn show(t: &str) -> Vec<String> {
        lines(t).into_iter().map(|l| l.replace(PLACEHOLDER, "#")).collect()
    }

    #[test]
    fn placeholders_and_branches() {
        let t = "M620 S[next_extruder]A\nG1 Z{max_layer_z + 3.0} F1200 ; lift\n{if old_filament_temp > 142 && next_extruder < 255}\nM104 S[old_filament_temp]\n{endif}\n";
        assert_eq!(show(t), vec!["M620 S#A", "G1 Z# F1200 ", "M104 S#"]);
        assert_eq!(show("{if a}M106 S255{else}M106 S0{endif}"), vec!["M106 S255", "M106 S0"]);
        assert_eq!(show("M104 S{nozzle_temperature[initial_extruder]-80}"), vec!["M104 S#"]);
        assert_eq!(show("{if filament_type[next_extruder] == \"PETG\"}\nM109 S260\n{endif}"), vec!["M109 S260"]);
        assert_eq!(show("; comment {if x}\nG28"), vec!["G28"]);
        assert_eq!(show("T[next_extruder]"), vec!["T#"]);
    }
}
