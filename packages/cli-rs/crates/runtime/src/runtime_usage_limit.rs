// The provider's own signal that the account's usage limit is used up. Hub
// classifies error text itself (agentUsageLimitFromError) and attributes the
// refusal's reset time against the raw reading; the host reports only what the
// provider said in a structured event plus a fresh provider reading.

use serde_json::Value;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use xmatrix_harness::quota::{self, Account, Provider, ReadOptions};
use xmatrix_harness::LlmUsage;
#[cfg(test)]
use xmatrix_harness::LlmQuotaUsage;

/// The provider account behind this Instance cannot run another turn until
/// `resets_at` (RFC 3339, UTC) when the provider said when.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct UsageLimit {
    pub(crate) resets_at: Option<String>,
}

/// A usage limit as reported to Hub: the refusal's reset time and the complete
/// provider reading taken after the refusal. Hub attributes which window was
/// used up from these raw facts.
#[derive(Clone, Debug)]
pub(crate) struct UsageLimitReport {
    pub(crate) resets_at: Option<String>,
    /// Why no reading or reset time could be supplied for Hub attribution.
    pub(crate) quota_scope_reason: Option<&'static str>,
    /// The complete provider reading taken after the refusal.
    pub(crate) usage: Option<LlmUsage>,
}

fn rfc3339_from_unix_seconds(seconds: i64) -> Option<String> {
    OffsetDateTime::from_unix_timestamp(seconds)
        .ok()?
        .format(&Rfc3339)
        .ok()
}

/// Whether a Claude Code this runtime spawns bills the default login, the
/// one account the usage reader can vouch for.
fn claude_spawn_uses_default_login() -> bool {
    xmatrix_harness::home_dir_path().is_some()
        && !quota::claude::CLAUDE_LOGIN_OVERRIDE_KEYS
            .iter()
            .any(|key| std::env::var(key).is_ok_and(|value| !value.trim().is_empty()))
}

/// Gather the raw provider reading after a Claude usage limit. Reads the usage
/// endpoint now, past any cached reading or rate-limit verdict (which only
/// repeat the refusal), sharing one request with any other read of the same
/// account. Hub attributes the scope from the refusal's reset time and reading.
pub(crate) async fn resolve_claude_usage_limit(limit: UsageLimit) -> UsageLimitReport {
    if xmatrix_cli_core::config::quota_probes_disabled() {
        return usage_limit_report(limit, Err("quota_probes_disabled"));
    }
    if !claude_spawn_uses_default_login() {
        return usage_limit_report(limit, Err("login_not_default"));
    }
    let reading = quota::read(
        Provider::Claude,
        ReadOptions {
            account: Account::DefaultLogin,
            force: true,
        },
    )
    .await;
    usage_limit_report(limit, reading.ok_or("usage_read_failed"))
}

fn usage_limit_report(
    limit: UsageLimit,
    reading: Result<LlmUsage, &'static str>,
) -> UsageLimitReport {
    let quota_scope_reason = match &reading {
        Err(reason) => Some(*reason),
        Ok(_) if limit.resets_at.is_none() => Some("no_reset_time"),
        Ok(_) => None,
    };
    UsageLimitReport {
        resets_at: limit.resets_at,
        quota_scope_reason,
        usage: reading.ok(),
    }
}

/// A Claude `rate_limit_event` whose window rejected the request
/// (`SDKRateLimitEvent`, `rate_limit_info.status: "rejected"`). Claude keeps
/// running the turn on overage when the account allows it, so this alone is
/// not a failure; the caller pairs it with a failed result.
pub(crate) fn claude_rate_limit_rejection(value: &Value) -> Option<UsageLimit> {
    if value.get("type").and_then(Value::as_str) != Some("rate_limit_event") {
        return None;
    }
    let info = value.get("rate_limit_info")?;
    if info.get("status").and_then(Value::as_str) != Some("rejected") {
        return None;
    }
    Some(UsageLimit {
        resets_at: info
            .get("resetsAt")
            .and_then(Value::as_i64)
            .and_then(rfc3339_from_unix_seconds),
    })
}

/// A Claude quota window as the usage reader maps one (tests).
#[cfg(test)]
pub(crate) fn claude_test_window(
    label: &str,
    percent: f64,
    reset: &str,
    scope: Option<&str>,
) -> LlmQuotaUsage {
    LlmQuotaUsage {
        label: Some(label.to_string()),
        window: Some("claude".to_string()),
        percent: Some(percent),
        reset_at: Some(reset.to_string()),
        scope: scope.map(str::to_string),
        ..LlmQuotaUsage::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use claude_test_window as window;

    #[test]
    fn claude_rejection_carries_the_reset_time() {
        let value = serde_json::json!({
            "type": "rate_limit_event",
            "rate_limit_info": { "status": "rejected", "rateLimitType": "five_hour", "resetsAt": 1_790_000_000 },
        });
        assert_eq!(
            claude_rate_limit_rejection(&value),
            Some(UsageLimit {
                resets_at: Some("2026-09-21T14:13:20Z".to_string())
            })
        );
    }

    #[test]
    fn claude_allowed_and_warning_events_are_not_limits() {
        for status in ["allowed", "allowed_warning"] {
            let value = serde_json::json!({
                "type": "rate_limit_event",
                "rate_limit_info": { "status": status, "resetsAt": 1_790_000_000 },
            });
            assert_eq!(claude_rate_limit_rejection(&value), None);
        }
        assert_eq!(
            claude_rate_limit_rejection(&serde_json::json!({ "type": "result" })),
            None
        );
    }

    /// The usage endpoint's `limits[]` on 2026-11-15 as the reader maps them:
    /// Fable's week used up, the account's week at 55%, both resetting at
    /// 2026-11-19T17:59:59.
    fn reading(session: f64, week: f64, fable: f64) -> LlmUsage {
        LlmUsage {
            quota_source: Some("provider_api".to_string()),
            quota_observed_at: Some("2026-11-15T12:00:00Z".to_string()),
            quota_usages: Some(vec![
                window("5h", session, "2026-11-15T23:00:00.312470+00:00", None),
                window("1w", week, "2026-11-19T17:59:59.768880+00:00", None),
            ]),
            scoped_quota_usages: Some(vec![window(
                "1w",
                fable,
                "2026-11-19T17:59:59.768897+00:00",
                Some("Fable"),
            )]),
            ..LlmUsage::default()
        }
    }

    fn refused_at(resets_at: &str) -> UsageLimit {
        UsageLimit {
            resets_at: Some(resets_at.to_string()),
        }
    }

    #[test]
    fn usage_limit_report_forwards_raw_reset_and_reading_for_hub_attribution() {
        let report = usage_limit_report(
            refused_at("2026-11-19T18:00:00Z"),
            Ok(reading(0.0, 55.0, 100.0)),
        );
        assert_eq!(report.resets_at.as_deref(), Some("2026-11-19T18:00:00Z"));
        assert_eq!(report.quota_scope_reason, None);
        assert!(report.usage.is_some(), "the reading travels for Hub attribution");
    }

    #[test]
    fn usage_limit_report_marks_missing_reset_time_and_failed_reads() {
        let missing_reset = usage_limit_report(UsageLimit::default(), Ok(reading(0.0, 55.0, 100.0)));
        assert_eq!(missing_reset.resets_at, None);
        assert_eq!(missing_reset.quota_scope_reason, Some("no_reset_time"));
        assert!(missing_reset.usage.is_some());

        let failed =
            usage_limit_report(refused_at("2026-11-19T18:00:00Z"), Err("usage_read_failed"));
        assert_eq!(failed.resets_at.as_deref(), Some("2026-11-19T18:00:00Z"));
        assert_eq!(failed.quota_scope_reason, Some("usage_read_failed"));
        assert!(failed.usage.is_none());
    }
}
