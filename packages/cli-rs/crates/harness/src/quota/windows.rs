//! Quota-window arithmetic shared by every provider reader.

use serde_json::{Map, Value};

use crate::fields::first_f64;
use crate::usage::LlmQuotaUsage;

/// Providers report percentages with no absolute budget. Their admission and
/// exhaustion rules stay at the caller; only the common wire meter is built here.
pub(crate) fn percent_window(
    label: &str,
    window: &str,
    percent: f64,
    exhausted: bool,
    reset_at: Option<String>,
) -> LlmQuotaUsage {
    LlmQuotaUsage {
        label: Some(label.into()),
        window: Some(window.into()),
        used: None,
        limit: None,
        remaining: exhausted.then_some(0.0),
        percent: normalized_quota_percent(Some(percent), None, None),
        reset_at,
    }
}

/// Whether a map is an app-server rate-limit snapshot (`primary`/`secondary`).
///
/// Those snapshots are session-local and never an account quota source; the
/// caller uses this to recognise and drop them.
pub fn is_rate_limit_snapshot_map(map: &Map<String, Value>) -> bool {
    map.contains_key("primary") || map.contains_key("secondary")
}

/// The short label the meters use for a window of `minutes` ("5h", "1w").
pub fn rate_limit_window_label(minutes: f64) -> Option<String> {
    if !minutes.is_finite() || minutes <= 0.0 {
        return None;
    }
    let minutes = minutes.round() as u64;
    if minutes.is_multiple_of(43_200) {
        return Some(format!("{}mo", minutes / 43_200));
    }
    if minutes.is_multiple_of(10_080) {
        return Some(format!("{}w", minutes / 10_080));
    }
    if minutes.is_multiple_of(1_440) {
        return Some(format!("{}d", minutes / 1_440));
    }
    if minutes.is_multiple_of(60) {
        return Some(format!("{}h", minutes / 60));
    }
    Some(format!("{minutes}m"))
}

/// Merge `next` into `target`, replacing a window with the same label/window
/// key (case-insensitively) rather than listing it twice.
pub fn append_quota_usages(target: &mut Option<Vec<LlmQuotaUsage>>, next: Vec<LlmQuotaUsage>) {
    if next.is_empty() {
        return;
    }
    let target = target.get_or_insert_with(Vec::new);
    for quota in next {
        let key = quota_usage_key(&quota);
        if key.is_empty() {
            target.push(quota);
            continue;
        }
        if let Some(existing) = target
            .iter_mut()
            .find(|item| quota_usage_key(item).eq_ignore_ascii_case(&key))
        {
            *existing = quota;
        } else {
            target.push(quota);
        }
    }
}

/// Settle a window's percent to 0-100 here, at the one place that still knows
/// which provider reported it, so `LlmQuotaUsage.percent` means the same thing
/// everywhere downstream: the status chips the runtime declares and the meters
/// the client derives read one number instead of each applying its own rule.
///
/// A reported percent is taken at face value. Every provider we read reports
/// 0-100 (`utilization: 33.0`, `used_percentage: 23.5`), and the rescale that
/// used to guess otherwise could only misfire: it read a reported 1% as 100%
/// and marked an idle agent as out of quota.
///
/// `used` and `limit` settle it outright when the window carries them, so the
/// windows that report both never depend on that convention at all.
pub fn normalized_quota_percent(
    reported: Option<f64>,
    used: Option<f64>,
    limit: Option<f64>,
) -> Option<f64> {
    if let (Some(used), Some(limit)) = (used, limit)
        && limit > 0.0
        && used.is_finite()
        && limit.is_finite()
    {
        return Some(((used / limit) * 100.0).max(0.0));
    }
    reported.filter(|percent| percent.is_finite() && *percent >= 0.0)
}

/// A percent derived from `limit` with `used` (or `remaining`), when the
/// window reports amounts instead of a percent.
pub fn quota_percent_from_usage_fields(map: &Map<String, Value>) -> Option<f64> {
    let limit = first_f64(map, &["limit", "max", "maximum", "quota", "total"])?;
    if limit <= 0.0 {
        return None;
    }
    if let Some(used) = first_f64(map, &["used", "usage", "current", "consumed"]) {
        return Some((used / limit) * 100.0);
    }
    if let Some(remaining) = first_f64(map, &["remaining", "available", "left"]) {
        return Some(((limit - remaining) / limit) * 100.0);
    }
    None
}

fn quota_usage_key(quota: &LlmQuotaUsage) -> String {
    let label = quota.label.as_deref().unwrap_or("").to_ascii_lowercase();
    let window = quota.window.as_deref().unwrap_or("").to_ascii_lowercase();
    match (label.is_empty(), window.is_empty()) {
        (true, true) => String::new(),
        (false, true) => label,
        (true, false) => window,
        (false, false) => format!("{label}:{window}"),
    }
}

/// Keep only the Codex windows (exact `codex` window first) and order them
/// 5h, 1w, then the rest.
pub fn prefer_codex_quota_windows(quotas: &mut Option<Vec<LlmQuotaUsage>>) {
    let Some(items) = quotas.as_mut() else {
        return;
    };
    let has_exact_codex = items.iter().any(is_exact_codex_quota_usage);
    if has_exact_codex {
        items.retain(is_exact_codex_quota_usage);
    } else if items.iter().any(is_codex_quota_usage) {
        items.retain(is_codex_quota_usage);
    }
    items.sort_by_key(|quota| {
        match quota
            .label
            .as_deref()
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str()
        {
            "5h" => 0,
            "1w" => 1,
            _ => 2,
        }
    });
}

fn is_exact_codex_quota_usage(quota: &LlmQuotaUsage) -> bool {
    quota
        .window
        .as_deref()
        .map(|value| value.eq_ignore_ascii_case("codex"))
        .unwrap_or(false)
}

fn is_codex_quota_usage(quota: &LlmQuotaUsage) -> bool {
    quota
        .window
        .as_deref()
        .or(quota.label.as_deref())
        .map(|value| value.to_ascii_lowercase().contains("codex"))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quota_percent_prefers_the_used_over_limit_ratio() {
        // A ratio needs no convention, so it settles the scale outright wherever the
        // window reports both numbers.
        assert_eq!(
            normalized_quota_percent(Some(0.5), Some(3.0), Some(12.0)),
            Some(25.0)
        );
        // Without them the reported value stands as-is, in 0-100.
        assert_eq!(normalized_quota_percent(Some(1.0), None, None), Some(1.0));
        // A limit of zero cannot produce a ratio, so it must not erase the report.
        assert_eq!(
            normalized_quota_percent(Some(7.0), Some(0.0), Some(0.0)),
            Some(7.0)
        );
        // Nonsense is dropped rather than rendered as a meter.
        assert_eq!(normalized_quota_percent(Some(-5.0), None, None), None);
        assert_eq!(normalized_quota_percent(Some(f64::NAN), None, None), None);
        assert_eq!(normalized_quota_percent(None, None, None), None);
    }

    #[test]
    fn rate_limit_window_label_formats_common_windows() {
        assert_eq!(rate_limit_window_label(120.0).as_deref(), Some("2h"));
        assert_eq!(rate_limit_window_label(300.0).as_deref(), Some("5h"));
        assert_eq!(rate_limit_window_label(10_080.0).as_deref(), Some("1w"));
        assert_eq!(rate_limit_window_label(43_200.0).as_deref(), Some("1mo"));
    }

    #[test]
    fn append_replaces_a_window_with_the_same_key() {
        let window = |label: &str, percent: f64| LlmQuotaUsage {
            label: Some(label.to_string()),
            window: Some("codex".to_string()),
            percent: Some(percent),
            ..LlmQuotaUsage::default()
        };
        let mut target = None;
        append_quota_usages(&mut target, vec![window("5h", 10.0), window("1w", 20.0)]);
        append_quota_usages(&mut target, vec![window("5H", 30.0)]);
        let target = target.unwrap();
        assert_eq!(target.len(), 2);
        assert_eq!(target[0].percent, Some(30.0));
    }
}
