//! Bambu Lab model ids (what sliced files' `printer_model_id` and the
//! profiles' `machine_model` `model_id` hold) and model names as OrcaSlicer's
//! profiles spell them.
//!
//! The profiles are the source of truth (`ProfileStore::machine_model`);
//! this table covers a server running without them, which can still send
//! uploaded projects to printers.

const MODELS: &[(&str, &str)] = &[
    ("BL-P001", "Bambu Lab X1 Carbon"),
    ("BL-P002", "Bambu Lab X1"),
    ("C13", "Bambu Lab X1E"),
    ("C11", "Bambu Lab P1P"),
    ("C12", "Bambu Lab P1S"),
    ("N1", "Bambu Lab A1 mini"),
    ("N2S", "Bambu Lab A1"),
    ("N6", "Bambu Lab X2D"),
    ("N7", "Bambu Lab P2S"),
    ("O1D", "Bambu Lab H2D"),
    ("O1E", "Bambu Lab H2D Pro"),
    ("O1S", "Bambu Lab H2S"),
];

pub fn id_for(name: &str) -> Option<&'static str> {
    MODELS.iter().find(|(_, n)| *n == name).map(|(id, _)| *id)
}

pub fn name_for(id: &str) -> Option<&'static str> {
    MODELS.iter().find(|(i, _)| *i == id).map(|(_, n)| *n)
}
