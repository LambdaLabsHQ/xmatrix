// The provider's own signal that the account's usage limit is used up. Hub
// classifies error text itself (agentUsageLimitFromError); the host reports
// only what the provider said in a structured event.

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
}
