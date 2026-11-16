// The provider's own signal that the account's usage limit is used up. Hub
// classifies error text itself (agentUsageLimitFromError); the host reports
// only what the provider said in a structured event.

use std::time::Duration;

use serde_json::Value;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use xmatrix_harness::quota::{self, Account, Provider, ReadOptions};
use xmatrix_harness::{LlmQuotaUsage, LlmUsage};

/// The provider account behind this Instance cannot run another turn until
/// `resets_at` (RFC 3339, UTC) when the provider said when.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct UsageLimit {
    pub(crate) resets_at: Option<String>,
}

/// A usage limit as reported to Hub: what it used up, told from a complete
/// provider reading taken after the refusal.
#[derive(Clone, Debug)]
pub(crate) struct UsageLimitReport {
    pub(crate) resets_at: Option<String>,
    /// `account`, the `scope` of one scoped window (`"Fable"`), or
    /// [`UNRESOLVED_QUOTA_SCOPE`].
    pub(crate) quota_scope: String,
    /// Why the scope is unresolved.
    pub(crate) quota_scope_reason: Option<&'static str>,
    /// The complete reading the scope was told from.
    pub(crate) usage: Option<LlmUsage>,
}

pub(crate) const ACCOUNT_QUOTA_SCOPE: &str = "account";
pub(crate) const UNRESOLVED_QUOTA_SCOPE: &str = "unresolved";

/// How far apart a refusal's reset and a window's reset may lie and still
/// name the same window. The refusal states whole seconds and the usage
/// endpoint the instant it computed: 18:00:00 against 17:59:59.768897 on
/// 2026-11-15. The account's own windows reset hours apart.
const RESET_MATCH_TOLERANCE: Duration = Duration::from_secs(2);

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

/// Tell what a Claude usage limit used up. Reads the usage endpoint now,
/// past any cached reading or rate-limit verdict (which only repeat the
/// refusal), sharing one request with any other read of the same account.
pub(crate) async fn resolve_claude_usage_limit(limit: UsageLimit) -> UsageLimitReport {
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
    let scope = reading
        .as_ref()
        .map_err(|reason| *reason)
        .and_then(|usage| {
            let resets_at = limit.resets_at.as_deref().ok_or("no_reset_time")?;
            quota_scope_by_reset(usage, resets_at).map(str::to_string)
        });
    let (quota_scope, quota_scope_reason) = match scope {
        Ok(scope) => (scope, None),
        Err(reason) => (UNRESOLVED_QUOTA_SCOPE.to_string(), Some(reason)),
    };
    UsageLimitReport {
        resets_at: limit.resets_at,
        quota_scope,
        quota_scope_reason,
        usage: reading.ok(),
    }
}

/// The window a refusal used up is the one that resets when the refusal
/// says (within [`RESET_MATCH_TOLERANCE`]). An account's week and a model's
/// week can reset at the same instant (both 2026-11-19T17:59:59 on
/// 2026-11-15); among windows that share the reset, the used-up one is it,
/// and the account's when it is used up too, since it stops every model.
fn quota_scope_by_reset<'a>(usage: &'a LlmUsage, resets_at: &str) -> Result<&'a str, &'static str> {
    let refused = OffsetDateTime::parse(resets_at, &Rfc3339).map_err(|_| "no_reset_time")?;
    let resets_with_refusal = |window: &&LlmQuotaUsage| {
        window
            .reset_at
            .as_deref()
            .and_then(|at| OffsetDateTime::parse(at, &Rfc3339).ok())
            .is_some_and(|at| (at - refused).unsigned_abs() <= RESET_MATCH_TOLERANCE)
    };
    let candidates: Vec<(&str, &LlmQuotaUsage)> = usage
        .quota_usages
        .iter()
        .flatten()
        .filter(resets_with_refusal)
        .map(|window| (ACCOUNT_QUOTA_SCOPE, window))
        .chain(
            usage
                .scoped_quota_usages
                .iter()
                .flatten()
                .filter(resets_with_refusal)
                .filter_map(|window| Some((window.scope.as_deref()?, window))),
        )
        .collect();
    let used_up: Vec<&str> = candidates
        .iter()
        .filter(|(_, window)| window.percent.is_some_and(|percent| percent >= 100.0))
        .map(|(scope, _)| *scope)
        .collect();
    match (candidates.as_slice(), used_up.as_slice()) {
        ([], _) => Err("no_matching_window"),
        ([(scope, _)], _) | (_, [scope]) => Ok(scope),
        (_, used_up) if used_up.contains(&ACCOUNT_QUOTA_SCOPE) => Ok(ACCOUNT_QUOTA_SCOPE),
        _ => Err("ambiguous_window"),
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

    fn scope_of(report: &UsageLimitReport) -> (&str, Option<&str>) {
        (report.quota_scope.as_str(), report.quota_scope_reason)
    }

    #[test]
    fn a_model_week_used_up_beside_the_account_week_is_that_models() {
        let report = usage_limit_report(
            refused_at("2026-11-19T18:00:00Z"),
            Ok(reading(0.0, 55.0, 100.0)),
        );
        assert_eq!(scope_of(&report), ("Fable", None));
        assert!(report.usage.is_some(), "the reading travels with the scope");
        assert_eq!(report.resets_at.as_deref(), Some("2026-11-19T18:00:00Z"));
    }

    #[test]
    fn the_account_is_used_up_when_its_own_window_is() {
        // The 5h session resets alone.
        let report = usage_limit_report(
            refused_at("2026-11-15T23:00:00Z"),
            Ok(reading(100.0, 55.0, 100.0)),
        );
        assert_eq!(scope_of(&report), ("account", None));
        // Both weeks used up: the account's stops every model.
        let report = usage_limit_report(
            refused_at("2026-11-19T18:00:00Z"),
            Ok(reading(0.0, 100.0, 100.0)),
        );
        assert_eq!(scope_of(&report), ("account", None));
    }

    #[test]
    fn one_window_at_the_refused_reset_is_it_whatever_its_rounded_percent() {
        let report = usage_limit_report(
            refused_at("2026-11-15T23:00:01Z"),
            Ok(reading(99.0, 55.0, 100.0)),
        );
        assert_eq!(scope_of(&report), ("account", None));
    }

    #[test]
    fn a_refusal_no_window_explains_is_unresolved() {
        // Beyond the 2 s tolerance of the session's 23:00:00.31 reset.
        let report = usage_limit_report(
            refused_at("2026-11-15T23:00:03Z"),
            Ok(reading(100.0, 55.0, 100.0)),
        );
        assert_eq!(
            scope_of(&report),
            ("unresolved", Some("no_matching_window"))
        );
        assert!(report.usage.is_some());

        // Both weeks share the reset and neither reads used up.
        let report = usage_limit_report(
            refused_at("2026-11-19T18:00:00Z"),
            Ok(reading(0.0, 99.0, 99.0)),
        );
        assert_eq!(scope_of(&report), ("unresolved", Some("ambiguous_window")));

        let report = usage_limit_report(UsageLimit::default(), Ok(reading(0.0, 55.0, 100.0)));
        assert_eq!(scope_of(&report), ("unresolved", Some("no_reset_time")));
    }

    #[test]
    fn a_failed_read_is_unresolved_and_carries_no_reading() {
        let report =
            usage_limit_report(refused_at("2026-11-19T18:00:00Z"), Err("usage_read_failed"));
        assert_eq!(scope_of(&report), ("unresolved", Some("usage_read_failed")));
        assert!(report.usage.is_none());
    }
}
