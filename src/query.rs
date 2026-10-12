//! Query-string helpers.

use serde::{Deserialize, Deserializer};

/// A boolean query flag that also takes `1`/`0`/`yes`/`no` (serde's bool
/// only takes `true`/`false`, so `?mine=1` failed to parse). Use with
/// `#[serde(default, deserialize_with = "crate::query::flag")]` on an
/// `Option<bool>`.
pub fn flag<'de, D: Deserializer<'de>>(d: D) -> Result<Option<bool>, D::Error> {
    let s = Option::<String>::deserialize(d)?;
    match s.as_deref().map(str::trim) {
        None | Some("") => Ok(None),
        Some("1" | "true" | "yes" | "on") => Ok(Some(true)),
        Some("0" | "false" | "no" | "off") => Ok(Some(false)),
        Some(other) => Err(serde::de::Error::custom(format!("expected a flag (1/0/true/false), got {other:?}"))),
    }
}

#[cfg(test)]
mod tests {
    #[derive(serde::Deserialize)]
    struct Q {
        #[serde(default, deserialize_with = "super::flag")]
        on: Option<bool>,
    }

    fn parse(qs: &str) -> Result<Option<bool>, String> {
        let uri: axum::http::Uri = format!("/x?{qs}").parse().unwrap();
        axum::extract::Query::<Q>::try_from_uri(&uri).map(|q| q.0.on).map_err(|e| e.to_string())
    }

    #[test]
    fn flags_parse() {
        assert_eq!(parse("on=1"), Ok(Some(true)));
        assert_eq!(parse("on=true"), Ok(Some(true)));
        assert_eq!(parse("on=0"), Ok(Some(false)));
        assert_eq!(parse(""), Ok(None));
        assert!(parse("on=maybe").is_err());
    }
}
