//! The token, context, and account-quota usage an agent harness reports.
//!
//! These are wire types: `xmatrix-cli-core` re-exports them as
//! `protocol::LlmUsage` / `protocol::LlmQuotaUsage`, so their serde shape is
//! part of the Hub protocol. Field names, casing, and the skip/default rules
//! must not change without a coordinated protocol change.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LlmUsage {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub output_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub total_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub context_used_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub context_window_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub context_usage_percent: Option<f64>,
    /// Account quota facts are displayable only when an explicit provider API
    /// reader produced them. App-server/session snapshots never set this.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub quota_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quota_observed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub quota_usages: Option<Vec<LlmQuotaUsage>>,
    /// Whether the provider still serves the account, read together with
    /// `quota_usages`. A used-up window does not stop an account the provider
    /// keeps serving (credits), and a provider refusal stops one whose windows
    /// look fine; spending is the provider account's own setting.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub quota_account: Option<LlmQuotaAccount>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub cached_input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub cache_creation_input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub cache_read_input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub reasoning_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub tool_call_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub cost_usd: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LlmQuotaUsage {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub window: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub used: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub limit: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub remaining: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub reset_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LlmQuotaAccount {
    /// The provider accepts another request from this account right now.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub allowed: Option<bool>,
    /// Paid credits the provider draws on once the windows are used up.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub credits: Option<LlmQuotaCredits>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LlmQuotaCredits {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub balance: Option<f64>,
    #[serde(skip_serializing_if = "std::ops::Not::not", default)]
    pub unlimited: bool,
}

/// Whether a usage report carries any fact at all.
pub fn has_llm_usage(usage: &LlmUsage) -> bool {
    usage.input_tokens.is_some()
        || usage.output_tokens.is_some()
        || usage.total_tokens.is_some()
        || usage.context_used_tokens.is_some()
        || usage.context_window_tokens.is_some()
        || usage.context_usage_percent.is_some()
        || usage
            .quota_usages
            .as_ref()
            .map(|items| !items.is_empty())
            .unwrap_or(false)
        || usage.cached_input_tokens.is_some()
        || usage.cache_creation_input_tokens.is_some()
        || usage.cache_read_input_tokens.is_some()
        || usage.reasoning_tokens.is_some()
        || usage.tool_call_count.is_some()
        || usage.cost_usd.is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn full_usage() -> LlmUsage {
        LlmUsage {
            input_tokens: Some(1),
            output_tokens: Some(2),
            total_tokens: Some(3),
            context_used_tokens: Some(4),
            context_window_tokens: Some(5),
            context_usage_percent: Some(6.5),
            quota_source: Some("provider_api".to_string()),
            quota_observed_at: Some("2026-09-21T18:00:00Z".to_string()),
            quota_usages: Some(vec![LlmQuotaUsage {
                label: Some("5h".to_string()),
                window: Some("claude".to_string()),
                used: Some(7.0),
                limit: Some(8.0),
                remaining: Some(1.0),
                percent: Some(87.5),
                reset_at: Some("1900000000".to_string()),
            }]),
            quota_account: Some(LlmQuotaAccount {
                allowed: Some(true),
                credits: Some(LlmQuotaCredits {
                    balance: Some(42.5),
                    unlimited: false,
                }),
            }),
            cached_input_tokens: Some(9),
            cache_creation_input_tokens: Some(10),
            cache_read_input_tokens: Some(11),
            reasoning_tokens: Some(12),
            tool_call_count: Some(13),
            cost_usd: Some(0.25),
        }
    }

    /// The exact JSON the Hub protocol has always carried for these types.
    fn full_usage_wire() -> serde_json::Value {
        json!({
            "inputTokens": 1,
            "outputTokens": 2,
            "totalTokens": 3,
            "contextUsedTokens": 4,
            "contextWindowTokens": 5,
            "contextUsagePercent": 6.5,
            "quotaSource": "provider_api",
            "quotaObservedAt": "2026-09-21T18:00:00Z",
            "quotaUsages": [{
                "label": "5h",
                "window": "claude",
                "used": 7.0,
                "limit": 8.0,
                "remaining": 1.0,
                "percent": 87.5,
                "resetAt": "1900000000"
            }],
            "quotaAccount": { "allowed": true, "credits": { "balance": 42.5 } },
            "cachedInputTokens": 9,
            "cacheCreationInputTokens": 10,
            "cacheReadInputTokens": 11,
            "reasoningTokens": 12,
            "toolCallCount": 13,
            "costUsd": 0.25
        })
    }

    #[test]
    fn wire_shape_is_camel_case_and_round_trips() {
        let encoded = serde_json::to_value(full_usage()).unwrap();
        assert_eq!(encoded, full_usage_wire());
        let decoded: LlmUsage = serde_json::from_value(full_usage_wire()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), full_usage_wire());
    }

    #[test]
    fn absent_fields_are_omitted_and_default_on_read() {
        assert_eq!(
            serde_json::to_value(LlmUsage::default()).unwrap(),
            json!({})
        );
        assert_eq!(
            serde_json::to_value(LlmQuotaUsage::default()).unwrap(),
            json!({})
        );
        let decoded: LlmUsage = serde_json::from_value(json!({})).unwrap();
        assert!(!has_llm_usage(&decoded));
        let decoded: LlmUsage =
            serde_json::from_value(json!({ "quotaUsages": [{ "percent": 3 }] })).unwrap();
        assert!(has_llm_usage(&decoded));
        assert_eq!(decoded.quota_usages.unwrap()[0].percent, Some(3.0));
    }

    #[test]
    fn empty_quota_list_is_not_usage() {
        let usage = LlmUsage {
            quota_usages: Some(Vec::new()),
            ..LlmUsage::default()
        };
        assert!(!has_llm_usage(&usage));
        assert!(has_llm_usage(&full_usage()));
    }
}
