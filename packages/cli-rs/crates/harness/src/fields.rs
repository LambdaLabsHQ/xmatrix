//! Tolerant field readers for provider JSON.
//!
//! Harness and provider payloads spell one fact several ways (`resetsAt`,
//! `resets_at`, `reset_at`) and send numbers as strings. Each reader takes the
//! candidate keys in precedence order and returns the first usable value.

use serde_json::{Map, Value};

/// A number, or a string that parses as one.
pub fn json_f64(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str()?.trim().parse::<f64>().ok())
}

/// The first key holding a number (or numeric string).
pub fn first_f64(map: &Map<String, Value>, keys: &[&str]) -> Option<f64> {
    keys.iter().find_map(|key| map.get(*key).and_then(json_f64))
}

/// The first key holding a non-blank string, trimmed.
pub fn first_string(map: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        map.get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    })
}

/// The first key holding a reset instant: a non-blank string as given, or a
/// positive epoch number rendered as its decimal text.
pub fn first_reset_at(map: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        let value = map.get(*key)?;
        if let Some(text) = value
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return Some(text.to_string());
        }
        let timestamp = value
            .as_i64()
            .or_else(|| value.as_u64().and_then(|number| i64::try_from(number).ok()))
            .or_else(|| value.as_f64().map(|number| number as i64))?;
        if timestamp <= 0 {
            return None;
        }
        Some(timestamp.to_string())
    })
}

/// The first key holding a number either directly or wrapped as
/// `{ "val" | "value" | "amount" | "total": n }` (proto3 money/credit JSON).
pub fn nested_val_number(map: &Map<String, Value>, keys: &[&str]) -> Option<f64> {
    for key in keys {
        let Some(value) = map.get(*key) else {
            continue;
        };
        if let Some(number) = json_f64(value) {
            return Some(number);
        }
        if let Some(object) = value.as_object()
            && let Some(number) = first_f64(object, &["val", "value", "amount", "total"])
        {
            return Some(number);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn map(value: Value) -> Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    #[test]
    fn readers_take_the_first_usable_key() {
        let fields = map(json!({
            "blank": "  ",
            "text": " 12.5 ",
            "number": 3,
            "reset_number": 1_900_000_000,
            "reset_zero": 0,
            "wrapped": { "val": 42 }
        }));
        assert_eq!(first_f64(&fields, &["missing", "text"]), Some(12.5));
        assert_eq!(first_f64(&fields, &["number", "text"]), Some(3.0));
        assert_eq!(
            first_string(&fields, &["blank", "text"]).as_deref(),
            Some("12.5")
        );
        assert_eq!(
            first_reset_at(&fields, &["reset_zero", "reset_number"]).as_deref(),
            Some("1900000000")
        );
        assert_eq!(nested_val_number(&fields, &["wrapped"]), Some(42.0));
        assert_eq!(nested_val_number(&fields, &["missing"]), None);
    }
}
