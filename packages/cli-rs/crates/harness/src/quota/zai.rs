//! Z.ai / Zhipu coding-plan quota, read from the monitor endpoint that serves
//! both the international and mainland hosts.

use std::time::Duration;

use serde_json::Value;

use super::cache::ProviderUsageCache;
use super::windows::{append_quota_usages, normalized_quota_percent};
use crate::fields::{first_f64, first_reset_at, first_string};
use crate::host::provider_client;
use crate::usage::{LlmQuotaUsage, LlmUsage, has_llm_usage};

const ZAI_QUOTA_LIMIT_URL: &str = "https://api.z.ai/api/monitor/usage/quota/limit";

const ZHIPU_QUOTA_LIMIT_URL: &str = "https://open.bigmodel.cn/api/monitor/usage/quota/limit";

static ZAI_QUOTA: ProviderUsageCache =
    ProviderUsageCache::new(Duration::from_secs(180), Duration::from_secs(60));

fn zai_coding_plan_api_key() -> Option<(String, &'static str)> {
    for (env_name, url) in [
        ("ZAI_API_KEY", ZAI_QUOTA_LIMIT_URL),
        ("ZHIPU_API_KEY", ZHIPU_QUOTA_LIMIT_URL),
        ("ZHIPUAI_API_KEY", ZHIPU_QUOTA_LIMIT_URL),
    ] {
        if let Ok(token) = std::env::var(env_name) {
            let trimmed = token.trim();
            if !trimmed.is_empty() {
                return Some((trimmed.to_string(), url));
            }
        }
    }
    None
}

/// Z.ai / BigModel Coding Plan quota (used by ZCode Coding Plan stats).
/// Auth header is the raw API key without a Bearer prefix (matches Z.ai monitor API).
pub async fn read_zai_coding_plan_quota_usage(force: bool) -> Option<LlmUsage> {
    if let Some(cached) = ZAI_QUOTA.hit_unless_forced(force) {
        return cached;
    }

    let Some((token, url)) = zai_coding_plan_api_key() else {
        return ZAI_QUOTA.unavailable();
    };

    let value = ZAI_QUOTA
        .fetch_json(
            "zai",
            provider_client()
                .get(url)
                // Z.ai monitor APIs expect the raw key, not "Bearer …".
                .header(reqwest::header::AUTHORIZATION, token)
                .header(reqwest::header::ACCEPT_LANGUAGE, "en-US,en")
                .header(reqwest::header::CONTENT_TYPE, "application/json"),
        )
        .await?;

    let usage = zai_coding_plan_usage_from_value(&value);
    ZAI_QUOTA.store(usage.clone());
    usage
}

pub fn zai_coding_plan_usage_from_value(value: &Value) -> Option<LlmUsage> {
    let mut usage = LlmUsage::default();
    append_quota_usages(
        &mut usage.quota_usages,
        zai_monitor_quota_usages(value.as_object()?),
    );
    if usage.quota_usages.is_some() {
        usage.quota_source = Some("provider_api".to_string());
    }
    has_llm_usage(&usage).then_some(usage)
}

/// Z.ai / BigModel Coding Plan monitor payload:
/// `{ "limits": [ { "type": "TOKENS_LIMIT", "unit": 3, "number": 5, "percentage": 40.5, "nextResetTime": ... } ] }`
/// unit=3/number=5 → 5h; unit=6/number=1 → weekly.
pub fn zai_monitor_quota_usages(map: &serde_json::Map<String, Value>) -> Vec<LlmQuotaUsage> {
    let limits = map.get("limits").and_then(Value::as_array).or_else(|| {
        map.get("data")
            .and_then(Value::as_object)
            .and_then(|data| data.get("limits"))
            .and_then(Value::as_array)
    });
    let Some(limits) = limits else {
        return Vec::new();
    };

    let mut quotas = Vec::new();
    for item in limits {
        let Some(item) = item.as_object() else {
            continue;
        };
        let limit_type = first_string(item, &["type", "rawType", "raw_type"]).unwrap_or_default();
        let unit = first_f64(item, &["unit"]);
        let number = first_f64(item, &["number"]);
        let percent = first_f64(
            item,
            &[
                "percentage",
                "percent",
                "pct",
                "usedPercent",
                "used_percent",
                "utilization",
            ],
        );
        let reset_at = first_reset_at(
            item,
            &[
                "nextResetTime",
                "next_reset_time",
                "resets_at",
                "resetsAt",
                "reset_at",
                "resetAt",
                "reset",
            ],
        );

        let label = if limit_type.eq_ignore_ascii_case("TOKENS_LIMIT")
            || limit_type.to_ascii_lowercase().contains("token")
        {
            match (unit.map(|v| v as i64), number.map(|v| v as i64)) {
                (Some(3), Some(5)) => Some("5h".to_string()),
                (Some(6), Some(1)) => Some("1w".to_string()),
                (Some(3), Some(n)) if n > 0 => Some(format!("{n}h")),
                (Some(6), Some(n)) if n > 0 => Some(format!("{n}w")),
                _ if limit_type.to_ascii_lowercase().contains("5")
                    || limit_type.to_ascii_lowercase().contains("hour") =>
                {
                    Some("5h".to_string())
                }
                _ if limit_type.to_ascii_lowercase().contains("week") => Some("1w".to_string()),
                _ => None,
            }
        } else if limit_type.eq_ignore_ascii_case("TIME_LIMIT")
            || limit_type.to_ascii_lowercase().contains("mcp")
        {
            Some("mcp".to_string())
        } else {
            None
        };

        let Some(label) = label else {
            continue;
        };
        if percent.is_none()
            && reset_at.is_none()
            && first_f64(item, &["currentValue", "current_value", "used"]).is_none()
        {
            continue;
        }
        let used = first_f64(item, &["currentValue", "current_value", "used", "usage"]);
        let limit = first_f64(item, &["total", "usage", "limit", "max"]);
        quotas.push(LlmQuotaUsage {
            label: Some(label),
            window: Some("zcode".to_string()),
            used,
            limit,
            remaining: first_f64(item, &["remaining", "available", "left"]),
            percent: normalized_quota_percent(percent, used, limit),
            reset_at,
        });
    }
    quotas
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zai_coding_plan_quota_limit_extracts_5h_and_weekly() {
        let payload = serde_json::json!({
            "data": {
                "level": "pro",
                "limits": [
                    {
                        "type": "TOKENS_LIMIT",
                        "unit": 3,
                        "number": 5,
                        "percentage": 40.5,
                        "nextResetTime": 1790012345000i64
                    },
                    {
                        "type": "TOKENS_LIMIT",
                        "unit": 6,
                        "number": 1,
                        "percentage": 52.0,
                        "nextResetTime": 1790617145000i64
                    },
                    {
                        "type": "TIME_LIMIT",
                        "percentage": 12.3,
                        "currentValue": 123,
                        "usage": 1000
                    }
                ]
            }
        });

        let usage = zai_coding_plan_usage_from_value(&payload).unwrap();
        assert_eq!(usage.quota_source.as_deref(), Some("provider_api"));
        let quotas = usage.quota_usages.unwrap();
        assert!(
            quotas
                .iter()
                .any(|q| q.label.as_deref() == Some("5h") && q.percent == Some(40.5))
        );
        assert!(
            quotas
                .iter()
                .any(|q| q.label.as_deref() == Some("1w") && q.percent == Some(52.0))
        );
        assert!(
            quotas
                .iter()
                .any(|q| q.label.as_deref() == Some("mcp") && q.percent == Some(12.3))
        );
    }
}
