//! Claude subscription quota: the OAuth usage endpoint Claude Code itself reads,
//! and the named 5h/1w windows it reports.

use std::time::Duration;

use serde_json::Value;

use super::cache::{KeyedProviderUsageCache, ProviderUsageCache};
use super::windows::{normalized_quota_percent, quota_percent_from_usage_fields};
use crate::claude_credentials::{claude_default_account_credential, claude_oauth_access_token};
use crate::fields::{first_f64, first_reset_at};
use crate::host::provider_client;
use crate::usage::{LlmQuotaAccount, LlmQuotaCredits, LlmQuotaUsage, LlmUsage};

/// Claude Code / Claude.ai OAuth usage uses named windows:
/// `five_hour` / `seven_day` with `used_percentage` or `utilization` (+ optional `resets_at`).
pub fn claude_named_window_quota_usages(
    map: &serde_json::Map<String, Value>,
) -> Vec<LlmQuotaUsage> {
    let mut quotas = Vec::new();
    for (keys, label) in [
        (&["five_hour", "fiveHour", "five-hour", "5h"][..], "5h"),
        (
            &["seven_day", "sevenDay", "seven-day", "7d", "1w", "weekly"][..],
            "1w",
        ),
    ] {
        let Some(window) = keys
            .iter()
            .find_map(|key| map.get(*key).and_then(Value::as_object))
        else {
            continue;
        };
        let percent = first_f64(
            window,
            &[
                "used_percentage",
                "usedPercentage",
                "usedPercent",
                "used_percent",
                "utilization",
                "percent",
                "pct",
            ],
        )
        .or_else(|| quota_percent_from_usage_fields(window));
        let reset_at = first_reset_at(
            window,
            &["resets_at", "resetsAt", "reset_at", "resetAt", "reset"],
        );
        if percent.is_none() && reset_at.is_none() {
            continue;
        }
        let used = first_f64(window, &["used", "usage", "current", "consumed"]);
        let limit = first_f64(window, &["limit", "max", "maximum", "quota", "total"]);
        quotas.push(LlmQuotaUsage {
            label: Some(label.to_string()),
            window: Some("claude".to_string()),
            used,
            limit,
            remaining: first_f64(window, &["remaining", "available", "left"]),
            percent: normalized_quota_percent(percent, used, limit),
            reset_at,
        });
    }
    quotas
}

const CLAUDE_OAUTH_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";

static CLAUDE_OAUTH_USAGE: ProviderUsageCache =
    ProviderUsageCache::new(Duration::from_secs(180), Duration::from_secs(60));

fn claude_code_user_agent() -> String {
    if let Ok(version) = std::env::var("CLAUDE_CODE_VERSION") {
        let trimmed = version.trim();
        if !trimmed.is_empty() {
            return format!("claude-code/{trimmed}");
        }
    }
    "claude-code/xmatrix".to_string()
}

/// How long Claude Code's own verdict stands in for the usage endpoint.
const CLAUDE_RATE_LIMIT_VERDICT_TTL: Duration = Duration::from_secs(10 * 60);

/// The quota Claude Code was told on this process's latest request.
static CLAUDE_RATE_LIMIT_VERDICT: std::sync::Mutex<Option<(std::time::Instant, LlmUsage)>> =
    std::sync::Mutex::new(None);

/// Claude Code's `rate_limit_event` as account quota.
///
/// Every request returns Anthropic's verdict on the account (`allowed`,
/// `allowed_warning`, `rejected`) and both windows' utilization as a fraction.
/// The usage endpoint rounds to whole percents and carries no verdict, so an
/// account at 99.6% that Anthropic still serves read as 100% and showed as a
/// hard limit (2026-10-05). `isUsingOverage` means the account is being served
/// past its windows on extra usage.
pub fn claude_rate_limit_event_usage(value: &Value) -> Option<LlmUsage> {
    if value.get("type").and_then(Value::as_str) != Some("rate_limit_event") {
        return None;
    }
    let info = value.get("rate_limit_info")?;
    let status = info.get("status").and_then(Value::as_str)?;
    let windows = info.get("unifiedWindows").and_then(Value::as_object)?;
    let quotas: Vec<LlmQuotaUsage> = [("five_hour", "5h"), ("seven_day", "1w")]
        .into_iter()
        .filter_map(|(key, label)| {
            let window = windows.get(key)?;
            let fraction = window.get("utilization").and_then(Value::as_f64)?;
            Some(LlmQuotaUsage {
                label: Some(label.to_string()),
                window: Some("claude".to_string()),
                percent: normalized_quota_percent(Some(fraction * 100.0), None, None),
                reset_at: claude_resets_at(window),
                ..LlmQuotaUsage::default()
            })
        })
        .collect();
    if quotas.is_empty() {
        return None;
    }
    let on_overage = info.get("isUsingOverage").and_then(Value::as_bool) == Some(true);
    Some(LlmUsage {
        quota_source: Some("provider_api".to_string()),
        quota_observed_at: super::observed_now(),
        quota_usages: Some(quotas),
        quota_account: Some(LlmQuotaAccount {
            allowed: Some(status != "rejected"),
            credits: on_overage.then(LlmQuotaCredits::default),
        }),
        ..LlmUsage::default()
    })
}

/// A rate-limit verdict's `resetsAt` (Unix seconds) as RFC 3339.
pub fn claude_resets_at(value: &Value) -> Option<String> {
    let secs = value.get("resetsAt").and_then(Value::as_i64)?;
    time::OffsetDateTime::from_unix_timestamp(secs)
        .ok()?
        .format(&time::format_description::well_known::Rfc3339)
        .ok()
}

/// Keep a `rate_limit_event` as this process's account quota; returns it.
pub fn record_claude_rate_limit_event(value: &Value) -> Option<LlmUsage> {
    let usage = claude_rate_limit_event_usage(value)?;
    if let Ok(mut verdict) = CLAUDE_RATE_LIMIT_VERDICT.lock() {
        *verdict = Some((std::time::Instant::now(), usage.clone()));
    }
    Some(usage)
}

fn fresh_claude_rate_limit_verdict() -> Option<LlmUsage> {
    let verdict = CLAUDE_RATE_LIMIT_VERDICT.lock().ok()?;
    let (seen, usage) = verdict.as_ref()?;
    (seen.elapsed() < CLAUDE_RATE_LIMIT_VERDICT_TTL).then(|| usage.clone())
}

/// Read Claude.ai subscription 5h/1w quotas: Claude Code's own verdict from a
/// recent request, else the same OAuth usage endpoint Claude Code uses.
pub async fn read_claude_oauth_rate_limit_usage(force: bool) -> Option<LlmUsage> {
    if let Some(verdict) = fresh_claude_rate_limit_verdict() {
        return Some(verdict);
    }
    if let Some(cached) = CLAUDE_OAUTH_USAGE.hit_unless_forced(force) {
        return cached;
    }

    let Some(token) = claude_oauth_access_token().await else {
        return CLAUDE_OAUTH_USAGE.unavailable();
    };

    let value = CLAUDE_OAUTH_USAGE
        .fetch_json("claude", claude_oauth_usage_request(&token))
        .await?;

    let usage = claude_oauth_usage_observed_now(&value);
    CLAUDE_OAUTH_USAGE.store(usage.clone());
    usage
}

fn claude_oauth_usage_request(token: &str) -> reqwest::RequestBuilder {
    provider_client()
        .get(CLAUDE_OAUTH_USAGE_URL)
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::USER_AGENT, claude_code_user_agent())
        .header("anthropic-beta", "oauth-2025-04-20")
}

fn claude_oauth_usage_observed_now(value: &Value) -> Option<LlmUsage> {
    let mut usage = claude_oauth_usage_from_value(value);
    if let Some(usage) = usage.as_mut() {
        usage.quota_observed_at = super::observed_now();
    }
    usage
}

/// Pre-launch probe readings, one slot per credential source and snapshot.
static CLAUDE_OAUTH_USAGE_BY_ACCOUNT: KeyedProviderUsageCache =
    KeyedProviderUsageCache::new(Duration::from_secs(180), Duration::from_secs(60));

/// Claude subscription quota for the default login (keychain, then
/// `~/.claude/.credentials.json`), keyed by that credential's source and exact
/// bytes so a login switch never reuses the previous account's reading.
///
/// The caller must first prove a spawn of its target resolves this same login
/// (no `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR`, or HOME override).
pub async fn read_claude_oauth_usage_for_default_account(force: bool) -> Option<LlmUsage> {
    let credential = claude_default_account_credential().await?;
    let key = credential.cache_key;
    if let Some(cached) = CLAUDE_OAUTH_USAGE_BY_ACCOUNT.hit_unless_forced(&key, force) {
        return cached;
    }
    let value = CLAUDE_OAUTH_USAGE_BY_ACCOUNT
        .fetch_json(
            &key,
            "claude",
            claude_oauth_usage_request(&credential.access_token),
        )
        .await?;
    // The request may outlive a login switch; never file a reading under the
    // new account's key or return it for the new account.
    if claude_default_account_credential().await?.cache_key != key {
        return None;
    }
    let usage = claude_oauth_usage_observed_now(&value);
    CLAUDE_OAUTH_USAGE_BY_ACCOUNT.store(&key, usage.clone());
    usage
}

pub fn claude_oauth_usage_from_value(value: &Value) -> Option<LlmUsage> {
    let quotas = claude_named_window_quota_usages(value.as_object()?);
    if quotas.is_empty() {
        return None;
    }
    Some(LlmUsage {
        quota_source: Some("provider_api".to_string()),
        quota_usages: Some(quotas),
        ..LlmUsage::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_oauth_usage_payload_extracts_utilization_windows() {
        let payload = serde_json::json!({
            "five_hour": {
                "utilization": 33.0,
                "resets_at": "2026-04-11T07:00:00.528743+00:00"
            },
            "seven_day": {
                "utilization": 13.0,
                "resets_at": "2026-04-17T00:59:59.951713+00:00"
            },
            "seven_day_opus": null,
            "extra_usage": {
                "is_enabled": false
            }
        });

        let quotas = super::super::assert_provider_window_labels(
            claude_oauth_usage_from_value(&payload).unwrap(),
            &["5h", "1w"],
        );
        assert_eq!(quotas[0].percent, Some(33.0));
        assert_eq!(
            quotas[0].reset_at.as_deref(),
            Some("2026-04-11T07:00:00.528743+00:00")
        );
        assert_eq!(quotas[1].percent, Some(13.0));
    }

    #[test]
    fn single_digit_quota_percent_survives_to_the_wire() {
        // A window barely touched must stay barely touched. Rescaling anything at or
        // below 1 read a reported 1% as 100%, which reached the client as a hard
        // usage limit on an agent that had spent almost nothing.
        let payload = serde_json::json!({
            "five_hour": { "utilization": 1.0, "resets_at": "2026-04-11T07:00:00+00:00" },
            "seven_day": { "utilization": 0.4, "resets_at": "2026-04-17T00:59:59+00:00" }
        });

        let usage = claude_oauth_usage_from_value(&payload).unwrap();
        let quotas = usage.quota_usages.unwrap();
        assert_eq!(quotas[0].label.as_deref(), Some("5h"));
        assert_eq!(quotas[0].percent, Some(1.0));
        assert_eq!(quotas[1].label.as_deref(), Some("1w"));
        assert_eq!(quotas[1].percent, Some(0.4));
    }

    #[test]
    fn claude_oauth_usage_ignores_limits_scoped_to_another_model() {
        // The live endpoint ships a `limits` array alongside the account windows.
        // Its entries can be scoped to one model — that is somebody else's quota,
        // and a generic tree walk used to keep them, so an unrelated model sitting
        // at 100% surfaced as an unlabelled quota on this agent.
        let payload = serde_json::json!({
            "five_hour": { "utilization": 40.0, "resets_at": "2026-08-04T18:00:00+00:00" },
            "seven_day": { "utilization": 60.0, "resets_at": "2026-08-05T13:00:00+00:00" },
            "limits": [
                { "kind": "session", "percent": 38, "resets_at": "2026-08-04T18:00:00+00:00" },
                { "kind": "weekly_all", "percent": 60, "resets_at": "2026-08-05T13:00:00+00:00" },
                {
                    "kind": "weekly_scoped",
                    "percent": 100,
                    "severity": "critical",
                    "resets_at": "2026-08-05T12:59:59+00:00",
                    "scope": { "model": { "display_name": "Fable" } }
                }
            ]
        });

        let quotas = claude_oauth_usage_from_value(&payload)
            .unwrap()
            .quota_usages
            .unwrap();

        // Exactly the two account windows: no duplicates from `limits`, no foreign
        // model's quota, and nothing without a label for the UI to fall back on.
        assert_eq!(quotas.len(), 2);
        assert_eq!(quotas[0].label.as_deref(), Some("5h"));
        assert_eq!(quotas[0].percent, Some(40.0));
        assert_eq!(quotas[1].label.as_deref(), Some("1w"));
        assert_eq!(quotas[1].percent, Some(60.0));
        assert!(quotas.iter().all(|quota| quota.label.is_some()));
        assert!(quotas.iter().all(|quota| quota.percent != Some(100.0)));
    }

    fn rate_limit_event(status: &str, seven_day: f64, overage: bool) -> Value {
        serde_json::json!({
            "type": "rate_limit_event",
            "rate_limit_info": {
                "status": status,
                "resetsAt": 1_791_482_400,
                "rateLimitType": "seven_day",
                "utilization": seven_day,
                "isUsingOverage": overage,
                "unifiedWindows": {
                    "five_hour": { "utilization": 0.35, "resetsAt": 1_791_237_600 },
                    "seven_day": { "utilization": seven_day, "resetsAt": 1_791_482_400 }
                }
            }
        })
    }

    #[test]
    fn an_account_claude_still_serves_reads_below_its_limit_and_allowed() {
        // 2026-10-05: the usage endpoint said 1w 100.0 while Claude Code was told
        // `allowed_warning` at 0.99, and the agent kept working under a red Limit.
        let usage =
            claude_rate_limit_event_usage(&rate_limit_event("allowed_warning", 0.99, false))
                .unwrap();
        let quotas = usage.quota_usages.unwrap();
        assert_eq!(quotas[0].label.as_deref(), Some("5h"));
        assert_eq!(quotas[0].percent, Some(35.0));
        assert_eq!(quotas[1].label.as_deref(), Some("1w"));
        assert_eq!(quotas[1].percent, Some(99.0));
        assert_eq!(quotas[1].reset_at.as_deref(), Some("2026-10-08T18:00:00Z"));
        assert_eq!(usage.quota_source.as_deref(), Some("provider_api"));
        assert!(usage.quota_observed_at.is_some());
        let account = usage.quota_account.unwrap();
        assert_eq!(account.allowed, Some(true));
        assert_eq!(account.credits, None, "no extra usage on this account");
    }

    #[test]
    fn a_refused_or_overage_served_account_says_so() {
        let refused = claude_rate_limit_event_usage(&rate_limit_event("rejected", 1.0, false))
            .unwrap()
            .quota_account
            .unwrap();
        assert_eq!(refused.allowed, Some(false));

        let on_overage = claude_rate_limit_event_usage(&rate_limit_event("allowed", 1.0, true))
            .unwrap()
            .quota_account
            .unwrap();
        assert_eq!(on_overage.allowed, Some(true));
        assert!(on_overage.credits.is_some());
    }

    #[test]
    fn other_events_and_windowless_verdicts_are_not_quota() {
        assert!(
            claude_rate_limit_event_usage(&serde_json::json!({ "type": "assistant" })).is_none()
        );
        let windowless = serde_json::json!({
            "type": "rate_limit_event",
            "rate_limit_info": { "status": "allowed", "rateLimitType": "five_hour" }
        });
        assert!(claude_rate_limit_event_usage(&windowless).is_none());
    }

    #[tokio::test]
    async fn a_recorded_verdict_answers_quota_reads_before_the_usage_endpoint() {
        record_claude_rate_limit_event(&rate_limit_event("allowed_warning", 0.99, false)).unwrap();
        let usage = read_claude_oauth_rate_limit_usage(true).await.unwrap();
        assert_eq!(usage.quota_account.unwrap().allowed, Some(true));
        assert_eq!(usage.quota_usages.unwrap()[1].percent, Some(99.0));
    }
}
