//! OpenCode Go subscription quota, read from the OpenCode usage endpoint behind
//! the API key the OpenCode CLI already stores for the `opencode-go` provider.
//!
//! OpenCode Go is a $10/month subscription with three nested dollar windows:
//! 5-hour (20% of the monthly limit), weekly (50%), and monthly (100%). The
//! endpoint reports only the percentage used and the window reset, so the
//! meters carry a percent and a reset instant rather than used/limit amounts.
//!
//! When OpenCode runs an `openai/*` model on a ChatGPT login (`opencode auth
//! login` → OpenAI → ChatGPT), the account quota is the ChatGPT subscription's
//! own 5h/1w windows. OpenCode stores that OAuth login under the `openai` entry
//! of the same `auth.json`, so the reader asks ChatGPT's `wham/usage` with it,
//! the endpoint behind the ChatGPT subscription windows.
//!
//! ACP `usage_update` notifications already carry the session's context usage
//! and cost; this reader adds the account-level quota windows that the generic
//! ACP path otherwise cannot see.

use std::path::PathBuf;
use std::time::Duration;

use serde_json::Value;

use super::cache::KeyedProviderUsageCache;
use super::windows::{
    append_quota_usages, credit_balance, normalized_quota_percent, percent_window,
    prefer_codex_quota_windows, quota_percent_from_usage_fields, rate_limit_window_label,
};
use crate::fields::{first_f64, first_reset_at, first_string};
use crate::host::{home_dir_path, provider_client};
use crate::usage::{LlmQuotaAccount, LlmQuotaCredits, LlmQuotaUsage, LlmUsage, has_llm_usage};

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

fn opencode_auth_file() -> Option<Value> {
    opencode_auth_dirs().iter().find_map(|dir| {
        let raw = std::fs::read_to_string(dir.join("auth.json")).ok()?;
        serde_json::from_str::<Value>(&raw).ok()
    })
}

/// The ChatGPT OAuth login OpenCode stored for its `openai` provider.
#[derive(Debug, PartialEq, Eq)]
struct OpenCodeChatGptLogin {
    access_token: String,
    account_id: Option<String>,
}

/// Read the `openai` OAuth entry. An API-key entry has no subscription quota,
/// and an expired access token is skipped rather than refreshed: refreshing
/// would rotate the refresh token OpenCode itself owns.
fn opencode_chatgpt_login_from_auth(value: &Value, now_ms: i64) -> Option<OpenCodeChatGptLogin> {
    let entry = value.as_object()?.get("openai")?.as_object()?;
    if entry
        .get("type")
        .and_then(Value::as_str)
        .is_some_and(|kind| kind != "oauth")
    {
        return None;
    }
    let access_token = first_string(entry, &["access", "access_token", "accessToken"])?;
    if let Some(expires) = entry.get("expires").and_then(Value::as_i64)
        && expires <= now_ms
    {
        return None;
    }
    Some(OpenCodeChatGptLogin {
        access_token,
        account_id: first_string(entry, &["accountId", "account_id"]),
    })
}

fn now_unix_ms() -> i64 {
    (time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64
}

/// ChatGPT subscription windows for OpenCode's stored `openai` OAuth login.
pub async fn read_opencode_chatgpt_usage(force: bool) -> Option<LlmUsage> {
    if super::quota_probes_disabled() {
        return None;
    }
    let auth = opencode_auth_file()?;
    read_opencode_chatgpt_usage_from(&auth, force, CHATGPT_WHAM_USAGE_URL).await
}

async fn read_opencode_chatgpt_usage_from(
    auth: &Value,
    force: bool,
    endpoint: &str,
) -> Option<LlmUsage> {
    let login = opencode_chatgpt_login_from_auth(auth, now_unix_ms())?;
    let key = format!(
        "opencode-openai\u{0}{}",
        login.account_id.as_deref().unwrap_or("")
    );
    read_chatgpt_wham_usage_with_token(
        &key,
        &login.access_token,
        login.account_id.as_deref(),
        force,
        endpoint,
    )
    .await
}

/// ChatGPT's subscription usage endpoint, asked with OpenCode's own stored
/// ChatGPT OAuth login.
const CHATGPT_WHAM_USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";

static CHATGPT_WHAM_USAGE: KeyedProviderUsageCache =
    KeyedProviderUsageCache::new(Duration::from_secs(120), Duration::from_secs(60));

/// One bounded `wham/usage` request for a ChatGPT access token.
async fn fetch_wham_usage_json(
    cache_key: &str,
    label: &str,
    access_token: &str,
    account_id: Option<&str>,
    endpoint: &str,
) -> Option<Value> {
    let mut request = provider_client()
        .get(endpoint)
        .header(
            reqwest::header::AUTHORIZATION,
            format!("Bearer {access_token}"),
        )
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::USER_AGENT, "xmatrix-cli");
    if let Some(account_id) = account_id {
        request = request.header("ChatGPT-Account-Id", account_id);
    }
    CHATGPT_WHAM_USAGE
        .fetch_json(cache_key, label, request)
        .await
}

/// Parse a `wham/usage` body, stamp it, and remember it under `cache_key`.
fn store_wham_usage(cache_key: &str, value: &Value) -> Option<LlmUsage> {
    // This endpoint is the account-level quota authority. Restrict parsing to
    // its wham envelope rather than accepting any rate-limit-like nested
    // object that could resemble an app-server session snapshot.
    let mut usage = chatgpt_wham_usage_from_value(value);
    if let Some(usage) = usage.as_mut() {
        usage.quota_observed_at = super::observed_now();
    }
    CHATGPT_WHAM_USAGE.store(cache_key, usage.clone());
    usage
}

/// ChatGPT subscription windows for OpenCode's stored ChatGPT OAuth token.
/// `cache_key` must identify the account so two logins never share one slot;
/// the token itself is never part of the key.
async fn read_chatgpt_wham_usage_with_token(
    cache_key: &str,
    access_token: &str,
    account_id: Option<&str>,
    force: bool,
    endpoint: &str,
) -> Option<LlmUsage> {
    if super::quota_probes_disabled() {
        return None;
    }
    if let Some(cached) = CHATGPT_WHAM_USAGE.hit_unless_forced(cache_key, force) {
        return cached;
    }
    let value =
        fetch_wham_usage_json(cache_key, "chatgpt", access_token, account_id, endpoint).await?;
    store_wham_usage(cache_key, &value)
}

fn chatgpt_wham_usage_from_value(value: &Value) -> Option<LlmUsage> {
    let mut best = LlmUsage::default();
    append_quota_usages(
        &mut best.quota_usages,
        chatgpt_wham_quota_usages(value.as_object()?),
    );
    prefer_codex_quota_windows(&mut best.quota_usages);
    if best.quota_usages.is_some() {
        best.quota_source = Some("provider_api".to_string());
        best.quota_account = chatgpt_wham_account(value);
    }
    if has_llm_usage(&best) {
        Some(best)
    } else {
        None
    }
}

/// Whether ChatGPT still serves the account, from the same `wham/usage` read.
/// `rate_limit.allowed` turns false as soon as the plan windows are used up,
/// even while `credits` keep serving requests; the account refuses only when
/// no credits are left or an overage or spend limit is reached.
fn chatgpt_wham_account(value: &Value) -> Option<LlmQuotaAccount> {
    let reached = |pointer: &str| value.pointer(pointer).and_then(Value::as_bool) == Some(true);
    let credits_serve = (reached("/credits/has_credits") || reached("/credits/unlimited"))
        && !reached("/credits/overage_limit_reached")
        && !reached("/spend_control/reached");
    let allowed = value
        .pointer("/rate_limit/allowed")
        .and_then(Value::as_bool)
        .map(|allowed| allowed || credits_serve);
    let credits = value
        .get("credits")
        .and_then(Value::as_object)
        .and_then(|credits| {
            let unlimited = credits.get("unlimited").and_then(Value::as_bool) == Some(true);
            let has_credits = credits.get("has_credits").and_then(Value::as_bool) == Some(true);
            (has_credits || unlimited).then(|| LlmQuotaCredits {
                balance: credit_balance(credits.get("balance")),
                currency: None,
                unlimited,
            })
        });
    (allowed.is_some() || credits.is_some()).then_some(LlmQuotaAccount { allowed, credits })
}

/// Parse ChatGPT Codex `wham/usage` style rate-limit windows.
/// Shape: `{ rate_limit: { primary_window: { used_percent, limit_window_seconds, reset_at }, secondary_window } }`.
/// App-server session snapshots use `primary`/`secondary` + `windowDurationMins`
/// and must not be accepted here: those values are per-session and jump when
/// more than one Codex thread is live.
fn chatgpt_wham_quota_usages(map: &serde_json::Map<String, Value>) -> Vec<LlmQuotaUsage> {
    if let Some(rate_limit) = map.get("rate_limit").and_then(Value::as_object) {
        return chatgpt_wham_rate_limit_object(rate_limit);
    }
    if map.contains_key("primary_window") || map.contains_key("secondary_window") {
        return chatgpt_wham_rate_limit_object(map);
    }
    Vec::new()
}

fn chatgpt_wham_rate_limit_object(map: &serde_json::Map<String, Value>) -> Vec<LlmQuotaUsage> {
    if !map.contains_key("primary_window") && !map.contains_key("secondary_window") {
        return Vec::new();
    }
    let mut quotas = Vec::new();
    for key in ["primary_window", "secondary_window"] {
        let Some(window) = map.get(key).and_then(Value::as_object) else {
            continue;
        };
        if let Some(quota) = chatgpt_wham_window_quota(window) {
            quotas.push(quota);
        }
    }
    quotas
}

fn chatgpt_wham_window_quota(window: &serde_json::Map<String, Value>) -> Option<LlmQuotaUsage> {
    let percent = first_f64(window, &["used_percent", "usedPercent", "percent", "pct"])
        .or_else(|| quota_percent_from_usage_fields(window))?;
    let duration_seconds = first_f64(
        window,
        &[
            "limit_window_seconds",
            "limitWindowSeconds",
            "window_duration_seconds",
            "windowDurationSeconds",
        ],
    )?;
    let label = rate_limit_window_label(duration_seconds / 60.0)?;
    Some(LlmQuotaUsage {
        label: Some(label),
        window: Some("Codex".to_string()),
        used: None,
        limit: None,
        remaining: None,
        percent: normalized_quota_percent(Some(percent), None, None),
        reset_at: first_reset_at(window, &["reset_at", "resetAt", "resets_at", "resetsAt"]),
        scope: None,
    })
}

/// Which account an OpenCode model draws on, from its `provider/model` id.
#[derive(Debug, PartialEq, Eq)]
enum OpenCodeQuotaSource {
    Go,
    ChatGpt,
    /// The model is not known yet: try Go first, then ChatGPT.
    Unknown,
    /// A provider with no account quota reader (API keys, other vendors).
    None,
}

fn opencode_quota_source(model: Option<&str>) -> OpenCodeQuotaSource {
    let Some(model) = model.map(str::trim).filter(|model| !model.is_empty()) else {
        return OpenCodeQuotaSource::Unknown;
    };
    let Some((provider, _)) = model.split_once('/') else {
        return OpenCodeQuotaSource::Unknown;
    };
    match provider.to_ascii_lowercase().as_str() {
        "opencode-go" => OpenCodeQuotaSource::Go,
        "openai" => OpenCodeQuotaSource::ChatGpt,
        _ => OpenCodeQuotaSource::None,
    }
}

/// The account quota behind the model OpenCode is running.
pub async fn read_opencode_usage_for_model(force: bool, model: Option<&str>) -> Option<LlmUsage> {
    match opencode_quota_source(model) {
        OpenCodeQuotaSource::Go => read_opencode_zen_usage(force).await,
        OpenCodeQuotaSource::ChatGpt => read_opencode_chatgpt_usage(force).await,
        OpenCodeQuotaSource::Unknown => match read_opencode_zen_usage(force).await {
            Some(usage) => Some(usage),
            None => read_opencode_chatgpt_usage(force).await,
        },
        OpenCodeQuotaSource::None => None,
    }
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
    if super::quota_probes_disabled() {
        return None;
    }
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

pub(crate) fn opencode_zen_usage_from_value(value: &Value) -> Option<LlmUsage> {
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
    fn opencode_model_provider_selects_the_quota_account() {
        assert_eq!(
            opencode_quota_source(Some("openai/gpt-6.1-terra")),
            OpenCodeQuotaSource::ChatGpt
        );
        assert_eq!(
            opencode_quota_source(Some("opencode-go/kimi-k2")),
            OpenCodeQuotaSource::Go
        );
        assert_eq!(
            opencode_quota_source(Some("anthropic/claude-opus")),
            OpenCodeQuotaSource::None
        );
        assert_eq!(opencode_quota_source(None), OpenCodeQuotaSource::Unknown);
        assert_eq!(
            opencode_quota_source(Some(" ")),
            OpenCodeQuotaSource::Unknown
        );
    }

    #[test]
    fn opencode_chatgpt_login_reads_live_oauth_and_skips_keys_and_expired_tokens() {
        let auth = serde_json::json!({
            "openai": {
                "type": "oauth",
                "access": "tok",
                "refresh": "r",
                "expires": 2_000,
                "accountId": "acct"
            }
        });
        assert_eq!(
            opencode_chatgpt_login_from_auth(&auth, 1_000),
            Some(OpenCodeChatGptLogin {
                access_token: "tok".into(),
                account_id: Some("acct".into()),
            })
        );
        assert_eq!(opencode_chatgpt_login_from_auth(&auth, 2_000), None);
        let api_key = serde_json::json!({ "openai": { "type": "api", "key": "sk" } });
        assert_eq!(opencode_chatgpt_login_from_auth(&api_key, 0), None);
        let go_only = serde_json::json!({ "opencode-go": { "type": "api", "key": "k" } });
        assert_eq!(opencode_chatgpt_login_from_auth(&go_only, 0), None);
    }

    #[tokio::test]
    async fn opencode_chatgpt_login_reads_wham_windows_with_account_header() {
        use std::io::Write;
        let auth = serde_json::json!({
            "openai": { "type": "oauth", "access": "tok", "accountId": "acct-1",
                        "expires": i64::MAX }
        });
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let endpoint = format!(
            "http://{}/backend-api/wham/usage",
            listener.local_addr().unwrap()
        );
        let server = std::thread::spawn(move || {
            let (mut stream, request) =
                crate::quota::read_fixture_http_request(&listener, "no wham request");
            let body = serde_json::json!({
                "rate_limit": {
                    "allowed": true,
                    "primary_window": { "used_percent": 12, "limit_window_seconds": 18000, "reset_at": 1_900_000_000 },
                    "secondary_window": { "used_percent": 40, "limit_window_seconds": 604800, "reset_at": 1_900_500_000 }
                }
            })
            .to_string();
            write!(
                stream,
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
            request
        });

        let usage = read_opencode_chatgpt_usage_from(&auth, true, &endpoint)
            .await
            .expect("chatgpt usage");
        let request = server.join().unwrap();
        assert!(request.contains("authorization: bearer tok"), "{request}");
        assert!(request.contains("chatgpt-account-id: acct-1"), "{request}");
        let quotas = crate::quota::assert_provider_window_labels(usage, &["5h", "1w"]);
        assert_eq!(quotas[0].percent, Some(12.0));
        assert_eq!(quotas[1].percent, Some(40.0));
    }

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

    #[test]
    fn chatgpt_wham_usage_extracts_primary_and_secondary_windows() {
        let payload = serde_json::json!({
            "plan_type": "pro",
            "rate_limit": {
                "allowed": true,
                "limit_reached": false,
                "primary_window": {
                    "used_percent": 40,
                    "limit_window_seconds": 604800,
                    "reset_after_seconds": 540609,
                    "reset_at": 1784487804
                },
                "secondary_window": {
                    "used_percent": 12.5,
                    "limit_window_seconds": 18000,
                    "reset_at": 1784012345
                }
            }
        });

        let quotas = crate::quota::assert_provider_window_labels(
            chatgpt_wham_usage_from_value(&payload).unwrap(),
            &["5h", "1w"],
        );
        assert_eq!(quotas[0].window.as_deref(), Some("Codex"));
        assert_eq!(quotas[0].percent, Some(12.5));
        assert_eq!(quotas[0].reset_at.as_deref(), Some("1784012345"));
        assert_eq!(quotas[1].percent, Some(40.0));
        assert_eq!(quotas[1].reset_at.as_deref(), Some("1784487804"));
    }

    #[test]
    fn chatgpt_wham_usage_keeps_whether_credits_still_serve_a_used_up_week() {
        let payload = serde_json::json!({
            "plan_type": "pro",
            "rate_limit": {
                "allowed": false,
                "limit_reached": true,
                "primary_window": { "used_percent": 100, "limit_window_seconds": 604800, "reset_at": 1791631680 }
            },
            "credits": {
                "has_credits": true,
                "unlimited": false,
                "overage_limit_reached": false,
                "balance": "137.5"
            },
            "spend_control": { "reached": false, "individual_limit": null }
        });
        let usage = chatgpt_wham_usage_from_value(&payload).unwrap();
        assert_eq!(usage.quota_usages.unwrap()[0].percent, Some(100.0));
        assert_eq!(
            usage.quota_account,
            Some(LlmQuotaAccount {
                allowed: Some(true),
                credits: Some(LlmQuotaCredits {
                    balance: Some(137.5),
                    currency: None,
                    unlimited: false
                }),
            })
        );

        let refused = serde_json::json!({
            "rate_limit": {
                "allowed": false,
                "limit_reached": true,
                "primary_window": { "used_percent": 100, "limit_window_seconds": 604800 }
            },
            "credits": { "has_credits": false, "unlimited": false, "balance": "0" }
        });
        assert_eq!(
            chatgpt_wham_usage_from_value(&refused)
                .unwrap()
                .quota_account,
            Some(LlmQuotaAccount {
                allowed: Some(false),
                credits: None
            })
        );

        let spend_capped = serde_json::json!({
            "rate_limit": {
                "allowed": false,
                "limit_reached": true,
                "primary_window": { "used_percent": 100, "limit_window_seconds": 604800 }
            },
            "credits": { "has_credits": true, "unlimited": false, "overage_limit_reached": false, "balance": "5" },
            "spend_control": { "reached": true }
        });
        assert_eq!(
            chatgpt_wham_usage_from_value(&spend_capped)
                .unwrap()
                .quota_account
                .unwrap()
                .allowed,
            Some(false)
        );
    }

    #[test]
    fn chatgpt_wham_usage_rejects_app_server_session_rate_limits() {
        // Session snapshots share a `rate_limit` wrapper but use primary/secondary
        // and minute windows. Accepting them made each Codex thread publish its own
        // meter and the Agents list jumped whenever another session heartbeated.
        let payload = serde_json::json!({
            "rate_limit": {
                "primary": { "usedPercent": 12, "windowDurationMins": 300 },
                "secondary": { "usedPercent": 34, "windowDurationMins": 10080 }
            }
        });
        assert!(chatgpt_wham_usage_from_value(&payload).is_none());

        let mixed = serde_json::json!({
            "rateLimits": {
                "primary": { "usedPercent": 94, "windowDurationMins": 300 },
                "secondary": { "usedPercent": 22, "windowDurationMins": 10080 }
            },
            "rateLimitsByLimitId": {
                "codex": {
                    "primary": { "usedPercent": 94, "windowDurationMins": 300 },
                    "secondary": { "usedPercent": 22, "windowDurationMins": 10080 }
                }
            }
        });
        assert!(chatgpt_wham_usage_from_value(&mixed).is_none());
    }

    #[test]
    fn chatgpt_wham_usage_handles_weekly_only_primary_window() {
        let payload = serde_json::json!({
            "rate_limit": {
                "primary_window": {
                    "used_percent": 40,
                    "limit_window_seconds": 604800,
                    "reset_at": 1784487804
                },
                "secondary_window": null
            }
        });

        let usage = chatgpt_wham_usage_from_value(&payload).unwrap();
        let quotas = usage.quota_usages.unwrap();
        assert_eq!(quotas.len(), 1);
        assert_eq!(quotas[0].label.as_deref(), Some("1w"));
        assert_eq!(quotas[0].window.as_deref(), Some("Codex"));
        assert_eq!(quotas[0].percent, Some(40.0));
    }
}
