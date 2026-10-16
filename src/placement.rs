//! Where the user put the model on the bed: the web viewer's orientation and
//! position, sent with a job (`placement` field) and applied by both engines
//! (`Placement` in cxx/slice_core.hpp).
//!
//! JSON: `{"rotation": [9 numbers], "offset": [dx, dy]}`. The rotation is a
//! row-major 3x3 matrix applied to the model as loaded; `offset` is where the
//! rotated model's bounding-box centre goes relative to the bed centre (mm).
//! The model always rests on the bed. No placement = centred, as loaded.
//!
//! A plate (`PlateLayout`, the job's `plate` field) holds one or more parts:
//! `{"objects": [{"model": 0, "placement": {...}}, ...]}`. `model` indexes
//! the job's models in upload order; a model can be placed several times
//! (copies). A lone part may go without a placement (centred); with several,
//! every part says where it goes.

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

/// Every part on the plate.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlateLayout {
    pub objects: Vec<PlateObject>,
}

impl PlateLayout {
    /// Parse and check a plate for a job with `models` source models.
    pub fn parse(text: &str, models: usize) -> Result<Self, String> {
        let plate: PlateLayout = serde_json::from_str(text).map_err(|e| format!("plate: {e}"))?;
        plate.check(models)?;
        Ok(plate)
    }

    /// One model, placed (or centred) the way jobs were before plates.
    pub fn single(placement: Option<Placement>) -> Self {
        PlateLayout {
            objects: vec![PlateObject { model: 0, placement }],
        }
    }

    fn check(&self, models: usize) -> Result<(), String> {
        if self.objects.is_empty() {
            return Err("plate: no parts".into());
        }
        if self.objects.len() > MAX_OBJECTS {
            return Err(format!("plate: more than {MAX_OBJECTS} parts"));
        }
        for o in &self.objects {
            if o.model >= models {
                return Err(format!("plate: part of model {} but the job has {models} model(s)", o.model));
            }
            if let Some(p) = &o.placement {
                p.check()?;
            }
        }
        if (0..models).any(|m| !self.objects.iter().any(|o| o.model == m)) {
            return Err("plate: every uploaded model must be on the plate".into());
        }
        if self.objects.len() > 1 && self.objects.iter().any(|o| o.placement.is_none()) {
            return Err("plate: with several parts, each needs a placement".into());
        }
        Ok(())
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
        let two = format!(r#"{{"objects":[{{"model":0,"placement":{ID}}},{{"model":0,"placement":{ID}}},{{"model":1,"placement":{ID}}}]}}"#);
        assert_eq!(PlateLayout::parse(&two, 2).unwrap().objects.len(), 3);
        // A lone part may be centred.
        assert!(PlateLayout::parse(r#"{"objects":[{"model":0}]}"#, 1).is_ok());
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
            assert!(PlateLayout::parse(&bad, models).is_err(), "{bad}");
        }
    }
}
