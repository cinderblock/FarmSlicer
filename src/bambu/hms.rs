//! What a Bambu printer's error codes mean, in the words Bambu's own apps
//! use: HMS codes and `print_error`.
//!
//! The texts are Bambu's, so FarmSlicer doesn't ship them: like Bambu Studio
//! and OrcaSlicer, it asks Bambu's server for the table of the printer's
//! device type (the first 3 characters of its serial) when a printer of that
//! type first reports, keeps it in `data/bambu-hms/<type>.json`, and asks
//! again after a week. Until a table arrives (or with no internet) a code
//! has no text; the printer card then shows the code and a link to Bambu's
//! help page for it ([`help_url`]). The request names only the device type
//! and the language, never the printer.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use crate::printer::status::PrinterStatus;

/// Bambu's message server (`AppConfig::get_hms_host` in OrcaSlicer).
const HOST: &str = "https://e.bambulab.com";
const LANG: &str = "en";
/// How old a table may get before it is asked for again (seconds).
const REFRESH_AFTER: i64 = 7 * 24 * 3600;
/// After a failed request, how long until the next try (seconds).
const RETRY_AFTER: i64 = 3600;

/// One device type's texts, by code (upper-case hex: 16 digits for HMS,
/// attr then code; 8 for `print_error`).
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
struct Table {
    #[serde(default)]
    hms: HashMap<String, String>,
    #[serde(default)]
    errors: HashMap<String, String>,
    /// Bambu's table version.
    #[serde(default)]
    version: i64,
    /// When it was fetched (Unix seconds).
    #[serde(default)]
    fetched: i64,
}

#[derive(Default)]
struct Store {
    /// Where tables are kept; None until [`init`] (tests, or no data dir).
    dir: Option<PathBuf>,
    tables: HashMap<String, Table>,
    /// Device types being fetched now.
    fetching: HashSet<String>,
    /// When each device type was last asked for.
    asked: HashMap<String, i64>,
}

fn store() -> &'static Mutex<Store> {
    static STORE: OnceLock<Mutex<Store>> = OnceLock::new();
    STORE.get_or_init(Default::default)
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

/// Load the tables kept in `data_dir/bambu-hms` (at startup).
pub fn init(data_dir: &Path) {
    let dir = data_dir.join("bambu-hms");
    let mut tables = HashMap::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let path = e.path();
            let Some(device) = path.file_stem().and_then(|s| s.to_str()).and_then(device_type) else { continue };
            if path.extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            match std::fs::read_to_string(&path).map_err(|e| e.to_string()).and_then(|s| serde_json::from_str::<Table>(&s).map_err(|e| e.to_string())) {
                Ok(t) => {
                    tables.insert(device, t);
                }
                Err(e) => eprintln!("Bambu messages: ignoring {}: {e}", path.display()),
            }
        }
    }
    let mut s = store().lock().unwrap();
    s.dir = Some(dir);
    s.tables.extend(tables);
}

/// A serial's device type ("00M", "094"...), if it has one.
fn device_type(serial: &str) -> Option<String> {
    let d = serial.get(..3)?;
    d.chars().all(|c| c.is_ascii_alphanumeric()).then(|| d.to_ascii_uppercase())
}

/// Bambu's answer to `query.php?lang=en&d=<type>`: `data.device_hms.en[]`
/// and `data.device_error.en[]`, each `{ecode, intro}`. An empty `intro` is
/// a code Bambu's apps don't show. `result` 201 = a device type Bambu has
/// no table for (an empty table, so it isn't asked again for a while).
fn parse(body: &str) -> Result<Table, String> {
    let v: Value = serde_json::from_str(body).map_err(|e| format!("not JSON: {e}"))?;
    match v["result"].as_i64() {
        Some(0) => {}
        Some(201) => return Ok(Table::default()),
        other => return Err(format!("result {other:?}")),
    }
    let texts = |key: &str| -> HashMap<String, String> {
        v["data"][key][LANG]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|i| {
                        let code = i["ecode"].as_str()?.trim().to_ascii_uppercase();
                        let text = i["intro"].as_str()?.trim();
                        (!code.is_empty() && !text.is_empty()).then(|| (code, text.to_string()))
                    })
                    .collect()
            })
            .unwrap_or_default()
    };
    let version = v["ver"].as_i64().or_else(|| v["ver"].as_str().and_then(|s| s.parse().ok())).unwrap_or(0);
    Ok(Table { hms: texts("device_hms"), errors: texts("device_error"), version, fetched: 0 })
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| crate::webhooks::internet_client(concat!("FarmSlicer/", env!("CARGO_PKG_VERSION"))))
}

async fn fetch(device: String) {
    let url = format!("{HOST}/query.php?lang={LANG}&d={device}");
    let result = async {
        let res = client().get(&url).timeout(Duration::from_secs(30)).send().await.map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            return Err(format!("HTTP {}", res.status()));
        }
        parse(&res.text().await.map_err(|e| e.to_string())?)
    }
    .await;
    let mut s = store().lock().unwrap();
    s.fetching.remove(&device);
    match result {
        Ok(mut table) => {
            table.fetched = now();
            println!("Bambu messages: {} HMS and {} error texts for device type {device}", table.hms.len(), table.errors.len());
            if let Some(dir) = s.dir.clone() {
                if let Err(e) = save(&dir, &device, &table) {
                    eprintln!("Bambu messages: can't keep the table for {device}: {e}");
                }
            }
            s.tables.insert(device, table);
        }
        // The table kept before (if any) stays in use.
        Err(e) => eprintln!("Bambu messages for device type {device}: {e} (asking again in an hour)"),
    }
}

fn save(dir: &Path, device: &str, table: &Table) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!("{device}.json.tmp"));
    std::fs::write(&tmp, serde_json::to_vec(table).expect("tables serialize"))?;
    std::fs::rename(tmp, dir.join(format!("{device}.json")))
}

/// Ask Bambu for `device`'s table when there is none or it is old, unless
/// a request is under way or failed lately. Needs a Tokio runtime (the
/// printer links run on one); without one it does nothing.
fn refresh_if_due(s: &mut Store, device: &str) {
    let t = now();
    let due = s.tables.get(device).is_none_or(|table| t - table.fetched > REFRESH_AFTER);
    let recently = s.asked.get(device).is_some_and(|at| t - at < RETRY_AFTER);
    if !due || recently || s.fetching.contains(device) {
        return;
    }
    let Ok(runtime) = tokio::runtime::Handle::try_current() else { return };
    s.fetching.insert(device.to_string());
    s.asked.insert(device.to_string(), t);
    runtime.spawn(fetch(device.to_string()));
}

fn lookup(serial: &str, code: &str, pick: fn(&Table) -> &HashMap<String, String>) -> Option<String> {
    let device = device_type(serial)?;
    let mut s = store().lock().unwrap();
    refresh_if_due(&mut s, &device);
    s.tables.get(&device).and_then(|t| pick(t).get(code)).cloned()
}

fn hms_key(attr: i64, code: i64) -> String {
    format!("{:08X}{:08X}", attr & 0xFFFF_FFFF, code & 0xFFFF_FFFF)
}

/// The text for an HMS code (`attr`, `code` as reported) on the printer with
/// this serial; `None` for codes Bambu doesn't explain, or before its
/// table has arrived.
pub fn hms_message(serial: &str, attr: i64, code: i64) -> Option<String> {
    lookup(serial, &hms_key(attr, code), |t| &t.hms)
}

/// The text for a `print_error` on the printer with this serial.
pub fn error_message(serial: &str, print_error: i64) -> Option<String> {
    lookup(serial, &format!("{:08X}", print_error & 0xFFFF_FFFF), |t| &t.errors)
}

/// Bambu's help page for an HMS code: their server sends it on to the
/// code's wiki page, or to the HMS index when there is none.
pub fn help_url(attr: i64, code: i64) -> String {
    format!("{HOST}/index.php?e={}&s=device_hms&lang={LANG}", hms_key(attr, code))
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

    /// What Bambu's server answers, trimmed to a few codes.
    const ANSWER: &str = r#"{"result":0,"t":1761000000,"ver":202609231145,"data":{
        "device_hms":{"en":[
            {"ecode":"0700200000020001","intro":"AMS A Slot 1 filament has run out. Please insert a new filament."},
            {"ecode":"0300010000010001","intro":"The heatbed temperature is abnormal; the heater may have a short circuit."},
            {"ecode":"0C00010000010001","intro":""}]},
        "device_error":{"en":[
            {"ecode":"07ff8006","intro":"Please feed filament into the PTFE tube until it can not be pushed any farther."},
            {"ecode":"0300400C","intro":"The task was canceled."}]}}}"#;

    fn with_table(device: &str, table: Table) {
        store().lock().unwrap().tables.insert(device.to_string(), Table { fetched: now(), ..table });
    }

    #[test]
    fn bambus_answer_parses() {
        let t = parse(ANSWER).unwrap();
        assert_eq!(t.version, 202609231145);
        assert_eq!(t.hms.len(), 2, "codes Bambu doesn't show are left out");
        assert_eq!(t.errors["07FF8006"], "Please feed filament into the PTFE tube until it can not be pushed any farther.");
        assert_eq!(parse(r#"{"result":201}"#).unwrap(), Table::default());
        assert!(parse(r#"{"result":400}"#).is_err());
        assert!(parse("<html>").is_err());
    }

    #[test]
    fn codes_are_looked_up_by_device_type() {
        with_table("T1X", parse(ANSWER).unwrap());
        // HMS: attr then code.
        assert_eq!(
            hms_message("t1x00A000000000", 0x0700_2000, 0x0002_0001).as_deref(),
            Some("AMS A Slot 1 filament has run out. Please insert a new filament.")
        );
        assert_eq!(error_message("T1X00A000000000", 0x0300_400C).as_deref(), Some("The task was canceled."));
        assert_eq!(error_message("T1X00A000000000", 0x7FFF_FFFF), None);
        // Another device type has its own table (none here), and no serial no type.
        assert_eq!(error_message("T2X00A000000000", 0x0300_400C), None);
        assert_eq!(error_message("", 0x0300_400C), None);
        assert_eq!(error_message("T-", 0x0300_400C), None);
    }

    #[test]
    fn help_links_go_through_bambus_redirector() {
        assert_eq!(help_url(0x0700_2000, 0x0002_0001), "https://e.bambulab.com/index.php?e=0700200000020001&s=device_hms&lang=en");
        assert_eq!(hms_key(-1, 1), "FFFFFFFF00000001");
    }

    /// Asks Bambu's server for real: `cargo test bambu::hms -- --ignored`.
    #[tokio::test]
    #[ignore = "needs the internet and Bambu's server"]
    async fn bambus_server_answers() {
        fetch("00M".to_string()).await;
        let s = store().lock().unwrap();
        let t = s.tables.get("00M").expect("the X1 table arrived");
        assert!(t.hms.len() > 1000 && t.errors.len() > 100, "{} HMS, {} errors", t.hms.len(), t.errors.len());
        assert!(t.version > 0 && t.fetched > 0);
    }

    #[test]
    fn tables_are_kept_and_found_again() {
        let dir = std::env::temp_dir().join(format!("fs-hms-test-{}", std::process::id()));
        let table = Table { fetched: 1, ..parse(ANSWER).unwrap() };
        save(&dir.join("bambu-hms"), "T3X", &table).unwrap();
        std::fs::write(dir.join("bambu-hms").join("broken.json"), "{").unwrap();
        init(&dir);
        assert_eq!(store().lock().unwrap().tables.get("T3X"), Some(&table));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
