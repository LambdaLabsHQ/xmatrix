//! Kimi Code quota: a weekly allowance plus whatever extra windows the
//! `/usages` payload names for itself.
//!
//! Only the parser lives here; there is no production HTTP reader for Kimi
//! yet, so [`super::read`] has no Kimi provider.

use serde_json::Value;

use super::windows::append_quota_usages;
use crate::fields::{first_f64, first_string};
use crate::usage::{LlmQuotaUsage, LlmUsage, has_llm_usage};

/// Parse the Kimi Code `/usages` payload:
/// `{ usage: {used?/remaining?, limit, resetAt?}, limits: [{ window: {duration,
/// timeUnit}, detail: {...} }] }`. The summary is the weekly allowance.
pub fn kimi_code_usage_from_value(value: &Value) -> Option<LlmUsage> {
    let map = value.as_object()?;
    let mut quotas = Vec::new();
    if let Some(summary) = map.get("usage").and_then(Value::as_object) {
        let label = kimi_quota_name_label(summary).unwrap_or_else(|| "1w".to_string());
        if let Some(quota) = kimi_quota_row(summary, label) {
            quotas.push(quota);
        }
    }
    if let Some(limits) = map.get("limits").and_then(Value::as_array) {
        for (idx, item) in limits.iter().enumerate() {
            let Some(item) = item.as_object() else {
                continue;
            };
            let detail = item
                .get("detail")
                .and_then(Value::as_object)
                .unwrap_or(item);
            let label = kimi_quota_name_label(item)
                .or_else(|| kimi_quota_name_label(detail))
                .or_else(|| kimi_window_label(item, detail))
                .unwrap_or_else(|| format!("limit {}", idx + 1));
            if let Some(quota) = kimi_quota_row(detail, label) {
                quotas.push(quota);
            }
        }
    }
    let mut usage = LlmUsage::default();
    append_quota_usages(&mut usage.quota_usages, quotas);
    if has_llm_usage(&usage) {
        Some(usage)
    } else {
        None
    }
}

fn kimi_quota_name_label(map: &serde_json::Map<String, Value>) -> Option<String> {
    let raw = first_string(map, &["name", "title", "scope"])?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.to_ascii_lowercase().contains("week") {
        return Some("1w".to_string());
    }
    Some(trimmed.chars().take(24).collect())
}

/// `window.duration` + `window.timeUnit` → the short labels the Agents panel
/// meters use ("5h", "1d"); kimi reports minute-based windows like 300 MINUTE.
fn kimi_window_label(
    item: &serde_json::Map<String, Value>,
    detail: &serde_json::Map<String, Value>,
) -> Option<String> {
    let window = item.get("window").and_then(Value::as_object);
    let field = |key: &str| {
        window
            .and_then(|window| window.get(key).cloned())
            .or_else(|| item.get(key).cloned())
            .or_else(|| detail.get(key).cloned())
    };
    let duration = field("duration").as_ref().and_then(Value::as_u64)?;
    if duration == 0 {
        return None;
    }
    let time_unit = field("timeUnit")
        .or_else(|| field("time_unit"))
        .as_ref()
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_uppercase();
    if time_unit.contains("MINUTE") {
        if duration >= 60 && duration % 60 == 0 {
            return Some(format!("{}h", duration / 60));
        }
        return Some(format!("{duration}m"));
    }
    if time_unit.contains("HOUR") {
        return Some(format!("{duration}h"));
    }
    if time_unit.contains("DAY") {
        if duration == 7 {
            return Some("1w".to_string());
        }
        return Some(format!("{duration}d"));
    }
    if time_unit.contains("WEEK") {
        return Some(format!("{duration}w"));
    }
    Some(format!("{duration}s"))
}

fn kimi_quota_row(data: &serde_json::Map<String, Value>, label: String) -> Option<LlmQuotaUsage> {
    let limit = first_f64(data, &["limit"]);
    let mut used = first_f64(data, &["used"]);
    let remaining = first_f64(data, &["remaining"]);
    if used.is_none()
        && let (Some(remaining), Some(limit)) = (remaining, limit)
    {
        used = Some((limit - remaining).max(0.0));
    }
    let (used, limit) = (used?, limit?);
    if limit <= 0.0 {
        return None;
    }
    Some(LlmQuotaUsage {
        label: Some(label),
        window: Some("kimi".to_string()),
        used: Some(used),
        limit: Some(limit),
        remaining: Some(remaining.unwrap_or((limit - used).max(0.0))),
        percent: Some((used / limit) * 100.0),
        reset_at: first_string(data, &["reset_at", "resetAt", "reset_time", "resetTime"]),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kimi_code_usages_payload_maps_weekly_and_windowed_limits() {
        // Shape of the Kimi Code /usages endpoint kimi-cli's /usage command reads:
        // a weekly summary plus windowed limits (duration/timeUnit + detail).
        let payload = serde_json::json!({
            "usage": {
                "name": "Weekly limit",
                "limit": 1000,
                "remaining": 400,
                "resetAt": "2026-08-10T00:00:00Z"
            },
            "limits": [
                {
                    "window": { "duration": 300, "timeUnit": "TIME_UNIT_MINUTE" },
                    "detail": { "limit": 100, "used": 25, "resetIn": 1200 }
                },
                {
                    "window": { "duration": 1, "timeUnit": "TIME_UNIT_DAY" },
                    "detail": { "limit": 500, "remaining": 100 }
                }
            ]
        });

        let usage = kimi_code_usage_from_value(&payload).expect("kimi usage");
        let quotas = usage.quota_usages.expect("kimi quotas");
        assert_eq!(quotas.len(), 3);

        assert_eq!(quotas[0].label.as_deref(), Some("1w"));
        assert_eq!(quotas[0].window.as_deref(), Some("kimi"));
        assert_eq!(quotas[0].used, Some(600.0));
        assert_eq!(quotas[0].limit, Some(1000.0));
        assert_eq!(quotas[0].remaining, Some(400.0));
        assert_eq!(quotas[0].percent, Some(60.0));
        assert_eq!(quotas[0].reset_at.as_deref(), Some("2026-08-10T00:00:00Z"));

        assert_eq!(quotas[1].label.as_deref(), Some("5h"));
        assert_eq!(quotas[1].used, Some(25.0));
        assert_eq!(quotas[1].percent, Some(25.0));

        assert_eq!(quotas[2].label.as_deref(), Some("1d"));
        assert_eq!(quotas[2].used, Some(400.0));
        assert_eq!(quotas[2].remaining, Some(100.0));
        assert_eq!(quotas[2].percent, Some(80.0));
    }

    #[test]
    fn kimi_code_usages_payload_without_meaningful_limits_is_none() {
        assert!(kimi_code_usage_from_value(&serde_json::json!({})).is_none());
        assert!(
            kimi_code_usage_from_value(&serde_json::json!({
                "usage": { "limit": 0, "used": 0 },
                "limits": []
            }))
            .is_none()
        );
    }
}
