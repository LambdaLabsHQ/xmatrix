//! Claude subscription quota: the OAuth usage endpoint Claude Code itself reads
//! (its `limits[]`), and the rate-limit verdict Claude Code gets per request.

use std::time::Duration;

use serde_json::Value;

use super::cache::{KeyedProviderUsageCache, ProviderUsageCache};
use super::windows::normalized_quota_percent;
use crate::claude_credentials::{claude_default_account_credential, claude_oauth_access_token};
use crate::host::provider_client;
use crate::usage::{LlmQuotaAccount, LlmQuotaCredits, LlmQuotaUsage, LlmUsage};

/// Environment that makes a Claude Code spawn bill something other than the
/// default login (a token, an API key, a gateway, a relocated config dir).
pub const CLAUDE_LOGIN_OVERRIDE_KEYS: &[&str] = &[
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CONFIG_DIR",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
];

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

/// Claude Code's `rate_limit_event` as a partial reading: the account windows
/// of `unifiedWindows` only, never a model's own limit.
///
/// Every request returns Anthropic's verdict (`allowed`, `allowed_warning`,
/// `rejected`) and both account windows' utilization as a fraction. The usage
/// endpoint rounds to whole percents and carries no verdict, so an account at
/// 99.6% that Anthropic still serves read as 100% and showed as a hard limit
/// (2026-10-05). `isUsingOverage` means the account is being served past its
/// windows on extra usage.
///
/// A `rejected` verdict states no account state: it may refuse one model
/// (`seven_day_fable`) while the account serves every other, and only the
/// usage endpoint says which limit it was.
pub(crate) fn claude_rate_limit_event_usage(value: &Value) -> Option<LlmUsage> {
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
        quota_account: (status != "rejected").then(|| LlmQuotaAccount {
            allowed: Some(true),
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

/// Read Claude.ai subscription quota: Claude Code's own verdict from a recent
/// request, else the same OAuth usage endpoint Claude Code uses.
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

/// Readings of the default login, one slot per credential source and snapshot.
static CLAUDE_OAUTH_USAGE_BY_ACCOUNT: KeyedProviderUsageCache =
    KeyedProviderUsageCache::new(Duration::from_secs(180), Duration::from_secs(60));

/// Claude subscription quota for the default login (keychain, then
/// `~/.claude/.credentials.json`), keyed by that credential's source and exact
/// bytes so a login switch never reuses the previous account's reading. It
/// never answers from a rate-limit verdict, and concurrent reads of one
/// account share a single request.
///
/// The caller must first prove a spawn of its target resolves this same login
/// (none of [`CLAUDE_LOGIN_OVERRIDE_KEYS`], no HOME override).
pub(crate) async fn read_claude_oauth_usage_for_default_account(force: bool) -> Option<LlmUsage> {
    let credential = claude_default_account_credential().await?;
    let key = credential.cache_key.as_str();
    if let Some(cached) = CLAUDE_OAUTH_USAGE_BY_ACCOUNT.hit_unless_forced(key, force) {
        return cached;
    }
    CLAUDE_OAUTH_USAGE_BY_ACCOUNT
        .single_flight(key, || async {
            let value = CLAUDE_OAUTH_USAGE_BY_ACCOUNT
                .fetch_json(
                    key,
                    "claude",
                    claude_oauth_usage_request(&credential.access_token),
                )
                .await?;
            // The request may outlive a login switch; never file a reading
            // under the new account's key or return it for the new account.
            if claude_default_account_credential().await?.cache_key != key {
                return None;
            }
            let usage = claude_oauth_usage_observed_now(&value);
            CLAUDE_OAUTH_USAGE_BY_ACCOUNT.store(key, usage.clone());
            usage
        })
        .await
}

/// The usage endpoint's `limits[]`, the complete reading: `session` is the
/// account's 5h window, `weekly_all` its 1w window, and each `weekly_scoped`
/// a 1w window of the models its `scope.model.display_name` names.
pub(crate) fn claude_oauth_usage_from_value(value: &Value) -> Option<LlmUsage> {
    let mut account = Vec::new();
    let mut scoped = Vec::new();
    for limit in value.get("limits")?.as_array()? {
        let Some(percent) =
            normalized_quota_percent(limit.get("percent").and_then(Value::as_f64), None, None)
        else {
            continue;
        };
        let window = |label: &str, scope: Option<&str>| LlmQuotaUsage {
            label: Some(label.to_string()),
            window: Some("claude".to_string()),
            percent: Some(percent),
            reset_at: limit
                .get("resets_at")
                .and_then(Value::as_str)
                .map(str::to_string),
            scope: scope.map(str::to_string),
            ..LlmQuotaUsage::default()
        };
        match limit.get("kind").and_then(Value::as_str) {
            Some("session") => account.push(window("5h", None)),
            Some("weekly_all") => account.push(window("1w", None)),
            Some("weekly_scoped") => {
                if let Some(scope) = limit
                    .pointer("/scope/model/display_name")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|scope| !scope.is_empty())
                {
                    scoped.push(window("1w", Some(scope)));
                }
            }
            _ => {}
        }
    }
    if account.is_empty() && scoped.is_empty() {
        return None;
    }
    Some(LlmUsage {
        quota_source: Some("provider_api".to_string()),
        quota_usages: (!account.is_empty()).then_some(account),
        scoped_quota_usages: Some(scoped),
        ..LlmUsage::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The live endpoint on 2026-11-15: Fable's own weekly limit used up while
    /// the account's week stood at 55%.
    fn live_usage_payload() -> Value {
        serde_json::json!({
            "five_hour": { "utilization": 0.0, "resets_at": null },
            "seven_day": { "utilization": 55.0, "resets_at": "2026-11-19T17:59:59.768880+00:00" },
            "limits": [
                { "kind": "session", "percent": 0, "resets_at": "2026-11-15T23:00:00.312470+00:00" },
                { "kind": "weekly_all", "percent": 55, "resets_at": "2026-11-19T17:59:59.768880+00:00" },
                {
                    "kind": "weekly_scoped",
                    "percent": 100,
                    "severity": "critical",
                    "resets_at": "2026-11-19T17:59:59.768897+00:00",
                    "scope": { "model": { "id": null, "display_name": "Fable" } }
                }
            ]
        })
    }

    #[test]
    fn usage_limits_map_to_account_and_scoped_windows() {
        let usage = claude_oauth_usage_from_value(&live_usage_payload()).unwrap();
        assert_eq!(usage.quota_source.as_deref(), Some("provider_api"));
        let account = super::super::assert_provider_window_labels(usage.clone(), &["5h", "1w"]);
        assert_eq!(account[0].percent, Some(0.0));
        assert_eq!(account[1].percent, Some(55.0));
        assert_eq!(
            account[1].reset_at.as_deref(),
            Some("2026-11-19T17:59:59.768880+00:00")
        );
        assert!(account.iter().all(|window| window.scope.is_none()));

        let scoped = usage.scoped_quota_usages.unwrap();
        assert_eq!(scoped.len(), 1);
        assert_eq!(scoped[0].label.as_deref(), Some("1w"));
        assert_eq!(scoped[0].scope.as_deref(), Some("Fable"));
        assert_eq!(scoped[0].percent, Some(100.0));
        assert_eq!(
            scoped[0].reset_at.as_deref(),
            Some("2026-11-19T17:59:59.768897+00:00")
        );
    }

    #[test]
    fn a_complete_reading_without_scoped_limits_says_so() {
        let payload = serde_json::json!({ "limits": [
            { "kind": "session", "percent": 1, "resets_at": "2026-11-15T23:00:00+00:00" },
            { "kind": "weekly_all", "percent": 0.4, "resets_at": "2026-11-19T18:00:00+00:00" }
        ]});
        let usage = claude_oauth_usage_from_value(&payload).unwrap();
        // A barely touched window stays barely touched.
        let account = usage.quota_usages.unwrap();
        assert_eq!(account[0].percent, Some(1.0));
        assert_eq!(account[1].percent, Some(0.4));
        // Present and empty: this reading clears any model limit seen before.
        assert!(
            usage
                .scoped_quota_usages
                .is_some_and(|scoped| scoped.is_empty())
        );
    }

    #[test]
    fn the_retired_named_window_keys_are_not_a_reading() {
        let legacy = serde_json::json!({
            "five_hour": { "utilization": 33.0, "resets_at": "2026-04-11T07:00:00+00:00" },
            "seven_day": { "utilization": 13.0, "resets_at": "2026-04-17T00:59:59+00:00" }
        });
        assert!(claude_oauth_usage_from_value(&legacy).is_none());
    }

    fn rate_limit_event(status: &str, kind: &str, seven_day: f64, overage: bool) -> Value {
        serde_json::json!({
            "type": "rate_limit_event",
            "rate_limit_info": {
                "status": status,
                "resetsAt": 1_791_482_400,
                "rateLimitType": kind,
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
        let usage = claude_rate_limit_event_usage(&rate_limit_event(
            "allowed_warning",
            "seven_day",
            0.99,
            false,
        ))
        .unwrap();
        let quotas = usage.quota_usages.unwrap();
        assert_eq!(quotas[0].label.as_deref(), Some("5h"));
        assert_eq!(quotas[0].percent, Some(35.0));
        assert_eq!(quotas[1].label.as_deref(), Some("1w"));
        assert_eq!(quotas[1].percent, Some(99.0));
        assert_eq!(quotas[1].reset_at.as_deref(), Some("2026-10-08T18:00:00Z"));
        assert_eq!(usage.quota_source.as_deref(), Some("provider_api"));
        assert!(usage.quota_observed_at.is_some());
        // A verdict is a partial reading: it never states the scoped windows.
        assert!(usage.scoped_quota_usages.is_none());
        let account = usage.quota_account.unwrap();
        assert_eq!(account.allowed, Some(true));
        assert_eq!(account.credits, None, "no extra usage on this account");
    }

    #[test]
    fn an_overage_served_account_says_so() {
        let on_overage =
            claude_rate_limit_event_usage(&rate_limit_event("allowed", "seven_day", 1.0, true))
                .unwrap()
                .quota_account
                .unwrap();
        assert_eq!(on_overage.allowed, Some(true));
        assert!(on_overage.credits.is_some());
    }

    #[test]
    fn a_rejection_keeps_the_account_windows_and_states_no_account_state() {
        // Fable's own limit refused the request while the account's week was
        // at half: the account still serves every other model.
        for kind in ["seven_day_fable", "seven_day"] {
            let usage =
                claude_rate_limit_event_usage(&rate_limit_event("rejected", kind, 0.5, true))
                    .unwrap();
            assert!(usage.quota_account.is_none(), "{kind}");
            assert!(usage.scoped_quota_usages.is_none(), "{kind}");
            let quotas = usage.quota_usages.unwrap();
            assert_eq!(quotas.len(), 2);
            assert!(quotas.iter().all(|window| window.scope.is_none()));
            assert_eq!(quotas[1].percent, Some(50.0));
        }
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
        record_claude_rate_limit_event(&rate_limit_event(
            "allowed_warning",
            "seven_day",
            0.99,
            false,
        ))
        .unwrap();
        let usage = read_claude_oauth_rate_limit_usage(true).await.unwrap();
        assert_eq!(usage.quota_account.unwrap().allowed, Some(true));
        assert_eq!(usage.quota_usages.unwrap()[1].percent, Some(99.0));
    }
}
