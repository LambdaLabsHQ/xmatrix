//! Cursor Agent subscription quota, read from the DashboardService usage
//! endpoint behind the CLI's stored login.
//!
//! Current Cursor Agent builds keep that login in the macOS login keychain
//! (`cursor-access-token` / `cursor-user`) and do not write `auth.json`.
//! Older installs and Windows still use `%APPDATA%/Cursor/auth.json`,
//! `~/.cursor/auth.json`, or the XDG config path. An explicit
//! `CURSOR_API_KEY` or `CURSOR_AUTH_TOKEN` wins over both.
//!
//! Cursor reports a billing-cycle meter (`totalPercentUsed`) plus Auto and API
//! bucket percentages. The CLI has no machine-readable `usage` subcommand, so
//! this reader calls the same Connect RPC the dashboard and `/usage` use.
//! Agents shows all three windows; Hub routing headroom ignores the API bucket
//! so a full on-demand API meter cannot refuse a launch while 1mo/Auto remain.
//!
//! Generic ACP otherwise has no account quota source for Cursor; without this
//! hook the Agents page and `xmatrix list` show `-`.

use std::path::PathBuf;

use serde_json::Value;

use super::windows::percent_window;
use crate::fields::{first_f64, first_string};
use crate::host::{home_dir_path, provider_client};
use crate::usage::{LlmQuotaUsage, LlmUsage};

const CURSOR_PERIOD_USAGE_URL: &str =
    "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";

/// Candidate auth.json locations the Cursor Agent CLI writes, in precedence
/// order. The CLI title-cases the domain on Windows (`Cursor`) and uses the
/// lowercase domain under XDG / `~/.cursor` elsewhere.
fn cursor_auth_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(appdata) = std::env::var_os("APPDATA") {
        paths.push(PathBuf::from(&appdata).join("Cursor").join("auth.json"));
        paths.push(PathBuf::from(appdata).join("cursor").join("auth.json"));
    }
    if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
        paths.push(PathBuf::from(xdg).join("cursor").join("auth.json"));
    }
    if let Some(home) = home_dir_path() {
        paths.push(home.join(".cursor").join("auth.json"));
        paths.push(home.join(".config").join("cursor").join("auth.json"));
        paths.push(
            home.join("AppData")
                .join("Roaming")
                .join("Cursor")
                .join("auth.json"),
        );
    }
    paths
}

fn cursor_token_from_auth_file(path: &PathBuf) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    let value: Value = serde_json::from_str(&raw).ok()?;
    let root = value.as_object()?;
    root.get("accessToken")
        .or_else(|| root.get("access_token"))
        .or_else(|| root.get("token"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn token_from_secret(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// Read the login-keychain item current Cursor Agent builds write on macOS.
/// There is no `auth.json` on these installs; skipping the keychain leaves
/// Agents and `xmatrix list` at `-`.
async fn cursor_keychain_access_token() -> Option<String> {
    let raw =
        crate::host::macos_keychain_password("cursor-access-token", Some("cursor-user")).await?;
    token_from_secret(&raw)
}

/// Resolve the bearer token the Cursor Agent CLI would use for dashboard RPCs.
async fn cursor_access_token() -> Option<String> {
    for key in ["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN"] {
        if let Ok(token) = std::env::var(key)
            && let Some(token) = token_from_secret(&token)
        {
            return Some(token);
        }
    }
    if let Some(token) = cursor_keychain_access_token().await {
        return Some(token);
    }
    cursor_auth_paths()
        .into_iter()
        .find_map(|path| cursor_token_from_auth_file(&path))
}

fn cursor_cli_user_agent() -> String {
    "xmatrix/cursor".to_string()
}

/// Cursor billing-cycle and Auto/API bucket quotas from GetCurrentPeriodUsage.
pub async fn read_cursor_period_usage(force: bool) -> Option<LlmUsage> {
    let cache = super::cache::account_meter_cache(super::cache::AccountMeter::Cursor);
    if let Some(cached) = cache.hit_unless_forced(force) {
        return cached;
    }

    let Some(token) = cursor_access_token().await else {
        return cache.unavailable();
    };

    let value = cache
        .fetch_json(
            "cursor",
            provider_client()
                .post(CURSOR_PERIOD_USAGE_URL)
                .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"))
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .header(reqwest::header::ACCEPT, "application/json")
                .header(reqwest::header::USER_AGENT, cursor_cli_user_agent())
                .header("Connect-Protocol-Version", "1")
                .body("{}"),
        )
        .await?;

    let usage = cursor_period_usage_from_value(&value);
    cache.store(usage.clone());
    usage
}

fn rfc3339_from_unix_millis(raw: &str) -> Option<String> {
    let digits: String = raw.chars().take_while(|ch| ch.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    let millis: i64 = digits.parse().ok()?;
    if millis <= 0 {
        return None;
    }
    let seconds = millis / 1000;
    time::OffsetDateTime::from_unix_timestamp(seconds)
        .ok()?
        .format(&time::format_description::well_known::Rfc3339)
        .ok()
}

fn cursor_reset_at(root: &serde_json::Map<String, Value>) -> Option<String> {
    let raw = first_string(
        root,
        &[
            "billingCycleEnd",
            "billing_cycle_end",
            "billingCycleEndMs",
            "resetAt",
            "resetsAt",
            "reset_at",
            "resets_at",
        ],
    )?;
    if raw.contains('T') {
        return Some(raw);
    }
    rfc3339_from_unix_millis(&raw)
}

fn push_percent_window(
    quotas: &mut Vec<LlmQuotaUsage>,
    label: &str,
    percent: Option<f64>,
    reset_at: Option<&str>,
) {
    let Some(percent) = percent.filter(|value| value.is_finite() && *value >= 0.0) else {
        return;
    };
    let exhausted = percent >= 100.0;
    quotas.push(percent_window(
        label,
        "cursor",
        percent,
        exhausted,
        reset_at.map(str::to_string),
    ));
}

pub fn cursor_period_usage_from_value(value: &Value) -> Option<LlmUsage> {
    let root = value.as_object()?;
    // A disabled meter still answers; treat it as no reading rather than inventing 0%.
    if root.get("enabled").and_then(Value::as_bool) == Some(false) {
        return None;
    }
    let plan = root
        .get("planUsage")
        .and_then(Value::as_object)
        .or(Some(root))?;
    let reset_at = cursor_reset_at(root);
    let mut quotas = Vec::new();
    push_percent_window(
        &mut quotas,
        "1mo",
        first_f64(
            plan,
            &[
                "totalPercentUsed",
                "total_percent_used",
                "percentUsed",
                "percent_used",
                "percent",
            ],
        ),
        reset_at.as_deref(),
    );
    push_percent_window(
        &mut quotas,
        "Auto",
        first_f64(plan, &["autoPercentUsed", "auto_percent_used"]),
        reset_at.as_deref(),
    );
    push_percent_window(
        &mut quotas,
        "API",
        first_f64(plan, &["apiPercentUsed", "api_percent_used"]),
        reset_at.as_deref(),
    );
    super::observed_provider_quotas(quotas)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_text_drops_blank_and_keeps_a_token() {
        assert_eq!(
            token_from_secret("  cursor-test-token\n").as_deref(),
            Some("cursor-test-token")
        );
        assert!(token_from_secret(" \n").is_none());
        assert!(token_from_secret("").is_none());
    }

    #[test]
    fn parses_billing_cycle_and_bucket_percents() {
        let value = serde_json::json!({
            "billingCycleEnd": "1791883943000",
            "enabled": true,
            "planUsage": {
                "totalPercentUsed": 60.35,
                "autoPercentUsed": 59.01,
                "apiPercentUsed": 100
            }
        });
        let usage = cursor_period_usage_from_value(&value).expect("usage");
        assert_eq!(usage.quota_source.as_deref(), Some("provider_api"));
        let windows = usage.quota_usages.expect("windows");
        assert_eq!(windows.len(), 3);
        assert_eq!(windows[0].label.as_deref(), Some("1mo"));
        assert_eq!(windows[0].percent, Some(60.35));
        assert_eq!(windows[0].remaining, None);
        assert_eq!(windows[0].reset_at.as_deref(), Some("2026-10-13T09:32:23Z"));
        assert_eq!(windows[1].label.as_deref(), Some("Auto"));
        assert_eq!(windows[1].percent, Some(59.01));
        assert_eq!(windows[2].label.as_deref(), Some("API"));
        assert_eq!(windows[2].percent, Some(100.0));
        assert_eq!(windows[2].remaining, Some(0.0));
    }

    #[test]
    fn disabled_or_empty_payload_is_unavailable() {
        assert!(cursor_period_usage_from_value(&serde_json::json!({ "enabled": false })).is_none());
        assert!(cursor_period_usage_from_value(&serde_json::json!({ "enabled": true })).is_none());
        assert!(cursor_period_usage_from_value(&serde_json::json!({})).is_none());
    }

    #[test]
    fn iso_reset_timestamps_pass_through() {
        let value = serde_json::json!({
            "billingCycleEnd": "2026-10-13T08:12:23Z",
            "enabled": true,
            "planUsage": { "totalPercentUsed": 12 }
        });
        let usage = cursor_period_usage_from_value(&value).expect("usage");
        assert_eq!(
            usage.quota_usages.as_ref().unwrap()[0].reset_at.as_deref(),
            Some("2026-10-13T08:12:23Z")
        );
    }
}
