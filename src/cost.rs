//! Filament cost estimates: grams per material times the farm's price per
//! kilogram (site setting `filament_prices`; defaults are Bambu Lab's refill
//! prices, as the old print station used).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::package::Plate;
use crate::db::{Db, Job};

const DEFAULTS: &[(&str, f64)] = &[
    ("PLA", 19.99),
    ("PLA-S", 19.99),
    ("PLA-CF", 31.99),
    ("PETG", 19.99),
    ("PETG-CF", 31.99),
    ("ABS", 19.99),
    ("ABS-S", 19.99),
    ("ABS-GF", 26.99),
    ("ASA", 26.99),
    ("ASA-CF", 33.99),
    ("TPU", 31.99),
    ("PC", 36.99),
    ("PA6-CF", 39.99),
    ("PA6-GF", 56.99),
    ("PET-CF", 41.99),
    ("PAHT-CF", 46.99),
    ("PPA-CF", 146.99),
    ("Support", 31.99),
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Prices {
    /// Shown before amounts, e.g. "$".
    pub currency: String,
    /// Material (as printers name it) → price per kg.
    pub per_kg: BTreeMap<String, f64>,
    /// For materials not listed.
    pub default_per_kg: f64,
}

impl Default for Prices {
    fn default() -> Self {
        Self {
            currency: "$".into(),
            per_kg: DEFAULTS.iter().map(|(m, p)| (m.to_string(), *p)).collect(),
            default_per_kg: 19.99,
        }
    }
}

impl Prices {
    pub fn load(db: &Db) -> Prices {
        db.get_setting("filament_prices")
            .and_then(|v| serde_json::from_str(&v).ok())
            .unwrap_or_default()
    }

    pub fn validate(&self) -> Result<(), String> {
        let bad = |p: f64| !p.is_finite() || p < 0.0 || p > 100_000.0;
        if bad(self.default_per_kg) || self.per_kg.values().any(|&p| bad(p)) {
            return Err("prices must be between 0 and 100000".into());
        }
        if self.currency.chars().count() > 8 || self.per_kg.keys().any(|k| k.trim().is_empty() || k.len() > 32) {
            return Err("currency up to 8 characters; material names 1-32".into());
        }
        Ok(())
    }

    /// Price per kg of a material: exact (any case), else its base material
    /// ("PLA" for "PLA Matte"), else the default.
    pub fn per_kg(&self, material: &str) -> f64 {
        let m = material.trim();
        let find = |name: &str| {
            self.per_kg
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(name))
                .map(|(_, p)| *p)
        };
        find(m)
            .or_else(|| m.split([' ', '-']).next().and_then(find))
            .unwrap_or(self.default_per_kg)
    }

    pub fn plate(&self, plate: &Plate) -> f64 {
        // Grams per filament as the G-code check settled them.
        round(
            plate
                .filaments
                .iter()
                .map(|f| crate::gcode::effective_grams(plate, f.id) * self.per_kg(&f.material) / 1000.0)
                .sum(),
        )
    }

    /// A job's estimate: its package's first plate, else its weight at the
    /// configured filament's price.
    pub fn job(&self, job: &Job) -> Option<f64> {
        if let Some(pkg) = crate::printing::package_of(job) {
            return pkg.plates.first().map(|p| self.plate(p));
        }
        let grams = job.filament_used_g?;
        let material = job
            .config_json
            .as_deref()
            .and_then(|c| serde_json::from_str::<Value>(c).ok())
            .and_then(|c| match &c["filament_type"] {
                Value::Array(a) => a.first().and_then(|v| v.as_str()).map(String::from),
                Value::String(s) => Some(s.clone()),
                _ => None,
            })
            .unwrap_or_else(|| "PLA".into());
        Some(round(grams * self.per_kg(&material) / 1000.0))
    }
}

fn round(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::package::FilamentUse;

    #[test]
    fn prices_by_material() {
        let p = Prices::default();
        assert_eq!(p.per_kg("pla"), 19.99);
        assert_eq!(p.per_kg("PLA-CF"), 31.99);
        assert_eq!(p.per_kg("PLA Matte"), 19.99);
        assert_eq!(p.per_kg("Unobtainium"), 19.99);
        let plate = Plate {
            index: 1,
            printer_model_id: None,
            printer_model: None,
            nozzle_diameters: None,
            print_time_sec: None,
            weight_g: None,
            filaments: vec![
                FilamentUse { id: 1, material: "PLA".into(), color: String::new(), filament_id: String::new(), used_g: 100.0, used_m: 0.0, nozzle: None },
                FilamentUse { id: 2, material: "PPA-CF".into(), color: String::new(), filament_id: String::new(), used_g: 10.0, used_m: 0.0, nozzle: None },
            ],
            has_thumbnail: false,
            gcode_md5: String::new(),
            bed_type: None,
            check: None,
        };
        assert_eq!(p.plate(&plate), 3.47); // 1.999 + 1.4699
    }
}
