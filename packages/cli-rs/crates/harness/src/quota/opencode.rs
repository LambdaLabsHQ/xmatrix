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
//! exactly as the Codex reader does for a Codex login.
//!
//! ACP `usage_update` notifications already carry the session's context usage
//! and cost; this reader adds the account-level quota windows that the generic
//! ACP path otherwise cannot see.

use std::path::PathBuf;

use serde_json::Value;

use super::windows::percent_window;
use crate::fields::{first_f64, first_string};
use crate::host::{home_dir_path, provider_client};
use crate::usage::LlmUsage;

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
    let auth = opencode_auth_file()?;
    read_opencode_chatgpt_usage_from(&auth, force, super::codex::CODEX_CHATGPT_USAGE_URL).await
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
    super::codex::read_chatgpt_wham_usage_with_token(
        &key,
        &login.access_token,
        login.account_id.as_deref(),
        force,
        endpoint,
    )
    .await
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
}
