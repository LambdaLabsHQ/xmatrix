// A provider turn that failed because the account's usage limit is used up.
// Hub hands the Instance's work to another harness on the same machine when it
// learns this, so the classification stays narrow: a transient rate limit or
// an overloaded provider is not a usage limit and must not move the work.

use serde_json::Value;

/// The provider account behind this Instance cannot run another turn until
/// `resets_at` (RFC 3339, UTC) when the provider said when.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct UsageLimit {
    pub(crate) resets_at: Option<String>,
}

fn rfc3339_from_unix_seconds(seconds: i64) -> Option<String> {
    time::OffsetDateTime::from_unix_timestamp(seconds)
        .ok()?
        .format(&time::format_description::well_known::Rfc3339)
        .ok()
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

/// A turn failure whose provider error says the account's usage limit or
/// quota is used up. Plain rate limiting (`429`, "rate limit", "overloaded")
/// is retried by the provider CLIs and is deliberately not matched.
pub(crate) fn usage_limit_from_error(error: &str) -> Option<UsageLimit> {
    let lower = error.to_ascii_lowercase();
    let limited = lower.contains("usage limit")
        || lower.contains("usage_limit")
        || lower.contains("usagelimitexceeded")
        || lower.contains("hit your limit")
        || lower.contains("hit your session limit")
        || lower.contains("hit your weekly limit")
        || (lower.contains("limit reached") && lower.contains("reset"))
        || lower.contains("insufficient_quota")
        || lower.contains("exceeded your current quota")
        || lower.contains("quota exceeded");
    if !limited {
        return None;
    }
    Some(UsageLimit {
        resets_at: claude_usage_limit_reset(error),
    })
}

/// Claude Code's legacy result text `Claude AI usage limit reached|<unix seconds>`.
fn claude_usage_limit_reset(error: &str) -> Option<String> {
    let (_, tail) = error.split_once("usage limit reached|")?;
    let digits: String = tail.chars().take_while(char::is_ascii_digit).collect();
    rfc3339_from_unix_seconds(digits.parse().ok()?)
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn provider_usage_limit_messages_are_limits() {
        for error in [
            "You've hit your usage limit. Upgrade to Pro or try again at 3:04 PM.",
            "You've hit your limit · resets 7pm (America/Los_Angeles)",
            "5-hour limit reached ∙ resets 3pm",
            "error_during_execution: usage_limit_reached",
            "{\"codexErrorInfo\":\"usageLimitExceeded\"}",
            "429 insufficient_quota: You exceeded your current quota",
            "Quota exceeded for quota metric 'Generate Content API requests'",
        ] {
            assert!(usage_limit_from_error(error).is_some(), "{error}");
        }
    }

    #[test]
    fn transient_failures_are_not_limits() {
        for error in [
            "Claude API error 429 (rate_limit_error); retry 3/10 in 8s",
            "Rate limit reached for requests",
            "Overloaded",
            "Codex app-server turn failed: stream disconnected before completion",
            "context window limit reached",
        ] {
            assert_eq!(usage_limit_from_error(error), None, "{error}");
        }
    }

    #[test]
    fn legacy_claude_text_carries_its_reset_time() {
        assert_eq!(
            usage_limit_from_error("Claude AI usage limit reached|1790000000"),
            Some(UsageLimit {
                resets_at: Some("2026-09-21T14:13:20Z".to_string())
            })
        );
    }
}
