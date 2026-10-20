//! Where the user put the model on the bed: the web viewer's orientation and
//! position, sent with a job (`placement` field) and applied by both engines
//! (`Placement` in cxx/slice_core.hpp).
//!
//! JSON: `{"rotation": [9 numbers], "offset": [dx, dy]}`. The rotation is a
//! row-major 3x3 matrix applied to the model as loaded; `offset` is where the
//! rotated model's bounding-box centre goes relative to the bed centre (mm).
//! The model always rests on the bed. No placement = centred, as loaded.
//!
//! A plate (`PlateLayout`) holds one or more parts:
//! `{"objects": [{"model": 0, "placement": {...}}, ...]}`. `model` indexes
//! the job's models in upload order; a model can be placed several times
//! (copies), on any plate. A job has one or more plates (`JobPlates`, the
//! job's `plates` field and `jobs.plate_json`: `{"plates": [plate, ...]}`;
//! a bare plate is one plate, as jobs were stored before several plates).
//! A lone part may go without a placement (centred); with several, every
//! part says where it goes. Every model is on some plate; no plate is empty.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Placement {
    pub rotation: [f64; 9],
    pub offset: [f64; 2],
}

/// How far a client's matrix may stray from a rotation (float rounding from
/// quaternion maths in the browser is ~1e-7).
const TOLERANCE: f64 = 1e-4;
/// Offsets beyond this are nonsense on any printer (mm).
const MAX_OFFSET: f64 = 10_000.0;

impl Placement {
    /// Parse and check a placement from a job request.
    pub fn parse(text: &str) -> Result<Self, String> {
        let p: Placement =
            serde_json::from_str(text).map_err(|e| format!("placement: {e}"))?;
        p.check()?;
        Ok(p)
    }

    fn check(&self) -> Result<(), String> {
        if self.rotation.iter().chain(&self.offset).any(|v| !v.is_finite()) {
            return Err("placement: numbers must be finite".into());
        }
        if self.offset.iter().any(|v| v.abs() > MAX_OFFSET) {
            return Err("placement: offset is beyond any bed".into());
        }
        // A rotation: orthonormal rows, determinant +1 (no mirroring or
        // scaling: the viewer does neither).
        let m = &self.rotation;
        let row = |i: usize| [m[i * 3], m[i * 3 + 1], m[i * 3 + 2]];
        let dot = |a: [f64; 3], b: [f64; 3]| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        for i in 0..3 {
            for j in 0..3 {
                let expected = if i == j { 1.0 } else { 0.0 };
                if (dot(row(i), row(j)) - expected).abs() > TOLERANCE {
                    return Err("placement: rotation is not a rotation matrix".into());
                }
            }
        }
        let det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6])
            + m[2] * (m[3] * m[7] - m[4] * m[6]);
        if (det - 1.0).abs() > TOLERANCE {
            return Err("placement: rotation must not mirror".into());
        }
        Ok(())
    }

}

/// Most parts one plate may hold (copies included).
pub const MAX_OBJECTS: usize = 500;

/// One part on the plate.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlateObject {
    /// Which of the job's models (0-based, upload order).
    pub model: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placement: Option<Placement>,
}

/// Most plates one job may have.
pub const MAX_PLATES: usize = 50;

/// Every part on one plate.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlateLayout {
    pub objects: Vec<PlateObject>,
}

/// Every plate of a job, in order (plate 1 first).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct JobPlates {
    pub plates: Vec<PlateLayout>,
}

/// What a job's plates may be stored or sent as: the list, or one bare
/// plate (jobs and pages from before several plates).
#[derive(Deserialize)]
#[serde(untagged)]
enum PlatesJson {
    Many(PlateList),
    One(PlateLayout),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PlateList {
    plates: Vec<PlateLayout>,
}

impl<'de> Deserialize<'de> for JobPlates {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Ok(match PlatesJson::deserialize(d)? {
            PlatesJson::Many(list) => JobPlates { plates: list.plates },
            PlatesJson::One(plate) => JobPlates { plates: vec![plate] },
        })
    }
}

impl JobPlates {
    /// Parse and check a job's plates (either shape) for a job with
    /// `models` source models.
    pub fn parse(text: &str, models: usize) -> Result<Self, String> {
        let plates: JobPlates = serde_json::from_str(text)
            .map_err(|_| r#"plate: expected {"plates": [{"objects": [...]}, ...]} or one plate"#.to_string())?;
        plates.check(models)?;
        Ok(plates)
    }

    /// One model, placed (or centred) the way jobs were before plates.
    pub fn single(placement: Option<Placement>) -> Self {
        JobPlates {
            plates: vec![PlateLayout {
                objects: vec![PlateObject { model: 0, placement }],
            }],
        }
    }

    fn check(&self, models: usize) -> Result<(), String> {
        if self.plates.is_empty() {
            return Err("plate: no plates".into());
        }
        if self.plates.len() > MAX_PLATES {
            return Err(format!("plate: more than {MAX_PLATES} plates"));
        }
        let several = self.several();
        for (i, plate) in self.plates.iter().enumerate() {
            let which = if several { format!("plate {}", i + 1) } else { "plate".to_string() };
            if plate.objects.is_empty() {
                return Err(format!("{which}: no parts"));
            }
            if plate.objects.len() > MAX_OBJECTS {
                return Err(format!("{which}: more than {MAX_OBJECTS} parts"));
            }
            for o in &plate.objects {
                if o.model >= models {
                    return Err(format!("{which}: part of model {} but the job has {models} model(s)", o.model));
                }
                if let Some(p) = &o.placement {
                    p.check()?;
                }
            }
        }
        if (0..models).any(|m| !self.parts().any(|o| o.model == m)) {
            return Err("plate: every uploaded model must be on a plate".into());
        }
        if self.parts().count() > 1 && self.parts().any(|o| o.placement.is_none()) {
            return Err("plate: with several parts, each needs a placement".into());
        }
        Ok(())
    }

    /// Every part on every plate, with its plate (0-based).
    pub fn parts_by_plate(&self) -> impl Iterator<Item = (usize, &PlateObject)> {
        self.plates.iter().enumerate().flat_map(|(i, p)| p.objects.iter().map(move |o| (i, o)))
    }

    fn parts(&self) -> impl Iterator<Item = &PlateObject> {
        self.plates.iter().flat_map(|p| &p.objects)
    }

    /// Several plates (only a package holds them all).
    pub fn several(&self) -> bool {
        self.plates.len() > 1
    }

    /// The part of a job with one part.
    pub fn lone_part(&self) -> Option<&PlateObject> {
        let mut parts = self.parts();
        match (parts.next(), parts.next()) {
            (Some(one), None) => Some(one),
            _ => None,
        }
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("plates serialize")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_rotations() {
        let identity = r#"{"rotation":[1,0,0,0,1,0,0,0,1],"offset":[0,0]}"#;
        assert!(Placement::parse(identity).is_ok());
        // 90° about X, moved off centre.
        let p = Placement::parse(r#"{"rotation":[1,0,0,0,0,-1,0,1,0],"offset":[-40.5,12]}"#).unwrap();
        assert_eq!(p.offset, [-40.5, 12.0]);
        // Rounding noise from the browser.
        let s = std::f64::consts::FRAC_1_SQRT_2 + 1e-7;
        assert!(Placement::parse(&format!(r#"{{"rotation":[{s},-{s},0,{s},{s},0,0,0,1],"offset":[0,0]}}"#)).is_ok());
    }

    #[test]
    fn refuses_non_rotations() {
        for bad in [
            r#"{"rotation":[2,0,0,0,1,0,0,0,1],"offset":[0,0]}"#,
            r#"{"rotation":[-1,0,0,0,1,0,0,0,1],"offset":[0,0]}"#,
            r#"{"rotation":[1,0.5,0,0,1,0,0,0,1],"offset":[0,0]}"#,
            r#"{"rotation":[1,0,0,0,1,0,0,0,1],"offset":[1e9,0]}"#,
            r#"{"rotation":[1,0,0,0,1,0,0,0],"offset":[0,0]}"#,
            r#"{"rotation":[1,0,0,0,1,0,0,0,1],"offset":[0,0],"scale":2}"#,
            r#"not json"#,
        ] {
            assert!(Placement::parse(bad).is_err(), "{bad}");
        }
    }

    const ID: &str = r#"{"rotation":[1,0,0,0,1,0,0,0,1],"offset":[0,0]}"#;

    #[test]
    fn plates() {
        // A bare plate (older pages, stored jobs) is one plate.
        let two = format!(r#"{{"objects":[{{"model":0,"placement":{ID}}},{{"model":0,"placement":{ID}}},{{"model":1,"placement":{ID}}}]}}"#);
        let parsed = JobPlates::parse(&two, 2).unwrap();
        assert_eq!(parsed.plates.len(), 1);
        assert_eq!(parsed.plates[0].objects.len(), 3);
        // A lone part may be centred.
        assert!(JobPlates::parse(r#"{"objects":[{"model":0}]}"#, 1).is_ok());
        assert!(JobPlates::parse(r#"{"plates":[{"objects":[{"model":0}]}]}"#, 1).is_ok());
        for (bad, models) in [
            (r#"{"objects":[]}"#.to_string(), 1),
            // No such model.
            (format!(r#"{{"objects":[{{"model":1,"placement":{ID}}}]}}"#), 1),
            // Model 1 uploaded but not placed.
            (format!(r#"{{"objects":[{{"model":0,"placement":{ID}}}]}}"#), 2),
            // Several parts, one without a placement.
            (format!(r#"{{"objects":[{{"model":0}},{{"model":0,"placement":{ID}}}]}}"#), 1),
            // A bad placement inside.
            (r#"{"objects":[{"model":0,"placement":{"rotation":[2,0,0,0,1,0,0,0,1],"offset":[0,0]}}]}"#.to_string(), 1),
            (r#"{"objects":[{"model":0,"scale":2}]}"#.to_string(), 1),
        ] {
            assert!(JobPlates::parse(&bad, models).is_err(), "{bad}");
        }
    }

    #[test]
    fn several_plates() {
        let part = |m: usize| format!(r#"{{"model":{m},"placement":{ID}}}"#);
        // Model 0 on both plates, model 1 on plate 2 only.
        let text = format!(r#"{{"plates":[{{"objects":[{}]}},{{"objects":[{},{}]}}]}}"#, part(0), part(0), part(1));
        let plates = JobPlates::parse(&text, 2).unwrap();
        assert!(plates.several());
        assert_eq!(plates.plates[1].objects.len(), 2);
        assert_eq!(plates.parts_by_plate().map(|(i, o)| (i, o.model)).collect::<Vec<_>>(), [(0, 0), (1, 0), (1, 1)]);
        // Stored as the list, read back the same.
        assert_eq!(JobPlates::parse(&plates.to_json(), 2).unwrap(), plates);
        for bad in [
            // An empty plate.
            format!(r#"{{"plates":[{{"objects":[{}]}},{{"objects":[]}}]}}"#, part(0)),
            // No plates.
            r#"{"plates":[]}"#.to_string(),
            // Model 1 on no plate.
            format!(r#"{{"plates":[{{"objects":[{}]}},{{"objects":[{}]}}]}}"#, part(0), part(0)),
            // Two lone parts: each needs a placement.
            r#"{"plates":[{"objects":[{"model":0}]},{"objects":[{"model":1}]}]}"#.to_string(),
            // Unknown keys.
            format!(r#"{{"plates":[{{"objects":[{}]}}],"extra":1}}"#, part(0)),
        ] {
            assert!(JobPlates::parse(&bad, 2).is_err(), "{bad}");
        }
        let one = format!(r#"{{"objects":[{}]}}"#, part(0));
        let many = format!(r#"{{"plates":[{}]}}"#, vec![one; MAX_PLATES + 1].join(","));
        assert!(JobPlates::parse(&many, 1).is_err());
    }
}
