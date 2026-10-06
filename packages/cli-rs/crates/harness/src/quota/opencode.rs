//! OpenCode Go subscription quota, read from the OpenCode usage endpoint behind
//! the API key the OpenCode CLI already stores for the `opencode-go` provider.
//!
//! OpenCode Go is a $10/month subscription with three nested dollar windows:
//! 5-hour (20% of the monthly limit), weekly (50%), and monthly (100%). The
//! endpoint reports only the percentage used and the window reset, so the
//! meters carry a percent and a reset instant rather than used/limit amounts.
//!
//! ACP `usage_update` notifications already carry the session's context usage
//! and cost; this reader adds the account-level quota windows that the generic
//! ACP path otherwise cannot see.

use std::path::PathBuf;

use serde_json::Value;

use super::windows::percent_window;
use crate::fields::{first_f64, first_string};
use crate::host::{home_dir_path, provider_client};
use crate::usage::LlmUsage;

// Only the OpenCode Go subscription exposes windowed account quota. OpenCode
// Zen is pay-as-you-go with no equivalent endpoint, so it has no reader here.
const OPENCODE_GO_USAGE_URL: &str = "https://opencode.ai/zen/go/v1/usage";

/// Candidate OpenCode data directories in precedence order. The CLI stores
/// `auth.json` under the XDG data root on Linux/Windows and under Application
/// Support on macOS.
fn opencode_auth_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(xdg) = std::env::var_os("XDG_DATA_HOME") {
        dirs.push(PathBuf::from(xdg).join("opencode"));
    }
    if let Some(home) = home_dir_path() {
        dirs.push(home.join(".local").join("share").join("opencode"));
        dirs.push(
            home.join("Library")
                .join("Application Support")
                .join("opencode"),
        );
        dirs.push(home.join("AppData").join("Roaming").join("opencode"));
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        dirs.push(PathBuf::from(appdata).join("opencode"));
    }
    dirs
}

fn opencode_key_from_auth_file(path: &PathBuf) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    let value: Value = serde_json::from_str(&raw).ok()?;
    let entry = value
        .as_object()?
        .get("opencode-go")
        .and_then(Value::as_object)?;
    entry
        .get("key")
        .or_else(|| entry.get("apiKey"))
        .or_else(|| entry.get("api_key"))
        .or_else(|| entry.get("token"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// Resolve the OpenCode Go API key stored by the OpenCode CLI.
fn opencode_usage_key() -> Option<String> {
    if let Ok(token) = std::env::var("OPENCODE_API_KEY") {
        let trimmed = token.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    opencode_auth_dirs()
        .iter()
        .find_map(|dir| opencode_key_from_auth_file(&dir.join("auth.json")))
}

/// OpenCode Go subscription windows from the usage endpoint.
pub async fn read_opencode_zen_usage(force: bool) -> Option<LlmUsage> {
    let cache = super::cache::account_meter_cache(super::cache::AccountMeter::OpenCode);
    if let Some(cached) = cache.hit_unless_forced(force) {
        return cached;
    }

    let Some(token) = opencode_usage_key() else {
        return cache.unavailable();
    };

    let value = cache
        .fetch_json(
            "opencode",
            provider_client()
                .get(OPENCODE_GO_USAGE_URL)
                .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"))
                .header(reqwest::header::ACCEPT, "application/json")
                .header(reqwest::header::USER_AGENT, "xmatrix/opencode"),
        )
        .await?;

    let usage = opencode_zen_usage_from_value(&value);
    cache.store(usage.clone());
    usage
}

pub fn opencode_zen_usage_from_value(value: &Value) -> Option<LlmUsage> {
    let payload = value
        .get("usage")
        .and_then(Value::as_object)
        .or_else(|| value.as_object())?;
    let mut quotas = Vec::new();
    for (field, label) in [("rolling", "5h"), ("weekly", "1w"), ("monthly", "1mo")] {
        let Some(entry) = payload.get(field).and_then(Value::as_object) else {
            continue;
        };
        let Some(percent) = first_f64(
            entry,
            &[
                "percent",
                "usedPercent",
                "used_percent",
                "usagePercent",
                "usage_percent",
            ],
        ) else {
            continue;
        };
        let exhausted = first_string(entry, &["status"])
            .is_some_and(|status| !status.eq_ignore_ascii_case("ok"))
            || percent >= 100.0;
        quotas.push(percent_window(
            label,
            "opencode",
            percent,
            exhausted,
            first_string(entry, &["resetsAt", "resets_at", "resetAt", "reset_at"]),
        ));
    }
    super::observed_provider_quotas(quotas)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opencode_usage_endpoint_extracts_rolling_weekly_monthly_windows() {
        let payload = serde_json::json!({
            "usage": {
                "rolling": {
                    "status": "ok",
                    "percent": 8,
                    "resetsAt": "2026-09-21T12:25:57.573Z"
                },
                "weekly": {
                    "status": "ok",
                    "percent": 3,
                    "resetsAt": "2026-09-28T00:00:00.000Z"
                },
                "monthly": {
                    "status": "ok",
                    "percent": 3,
                    "resetsAt": "2026-10-14T20:57:54.000Z"
                }
            }
        });

        let usage = opencode_zen_usage_from_value(&payload).expect("opencode usage");
        assert_eq!(usage.quota_source.as_deref(), Some("provider_api"));
        assert!(usage.quota_observed_at.is_some());
        let quotas = usage.quota_usages.expect("opencode quotas");
        assert!(
            quotas
                .iter()
                .any(|q| q.label.as_deref() == Some("5h") && q.percent == Some(8.0))
        );
        assert!(
            quotas
                .iter()
                .any(|q| q.label.as_deref() == Some("1w") && q.percent == Some(3.0))
        );
        assert!(quotas.iter().any(|q| {
            q.label.as_deref() == Some("1mo")
                && q.percent == Some(3.0)
                && q.reset_at.as_deref() == Some("2026-10-14T20:57:54.000Z")
        }));
    }

    #[test]
    fn opencode_usage_endpoint_marks_an_exhausted_window_and_ignores_other_shapes() {
        let exhausted = serde_json::json!({
            "usage": {
                "rolling": { "status": "exceeded", "percent": 100, "resetsAt": "2026-09-21T12:25:57Z" }
            }
        });
        let usage = opencode_zen_usage_from_value(&exhausted).expect("usage");
        let quota = &usage.quota_usages.expect("quotas")[0];
        assert_eq!(quota.label.as_deref(), Some("5h"));
        assert_eq!(quota.remaining, Some(0.0));

        assert!(opencode_zen_usage_from_value(&serde_json::json!({})).is_none());
        assert!(
            opencode_zen_usage_from_value(&serde_json::json!({
                "usage": { "rolling": { "status": "ok" } }
            }))
            .is_none()
        );
    }
}
