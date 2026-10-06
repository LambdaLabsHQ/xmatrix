//! Codex / ChatGPT quota, read from the wham usage endpoint so the Agents panel
//! can show 5h/1w windows while the agent is idle or mid-turn.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::Value;
use sha2::{Digest, Sha256};

use super::cache::KeyedProviderUsageCache;
use super::windows::{
    append_quota_usages, normalized_quota_percent, prefer_codex_quota_windows,
    quota_percent_from_usage_fields, rate_limit_window_label,
};
use crate::fields::{first_f64, first_reset_at, first_string};
use crate::host::{lowercase_hex, provider_client};
use crate::usage::{LlmQuotaAccount, LlmQuotaCredits, LlmQuotaUsage, LlmUsage, has_llm_usage};

const CODEX_CHATGPT_USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";

static CODEX_CHATGPT_USAGE: KeyedProviderUsageCache =
    KeyedProviderUsageCache::new(Duration::from_secs(120), Duration::from_secs(60));

fn codex_home_dir() -> Option<PathBuf> {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".codex")))
}

/// The cache key is the exact config home plus a content fingerprint of the
/// `auth.json` snapshot, so two Profiles that resolve to different accounts
/// never share a reading and a rotated `auth.json` at one path is not answered
/// from the previous account.
fn codex_quota_cache_key(home: &Path, auth_fingerprint: &str) -> String {
    let base = home.canonicalize().unwrap_or_else(|_| home.to_path_buf());
    format!("{}\u{0}{auth_fingerprint}", base.to_string_lossy())
}

/// A one-way fingerprint of the exact `auth.json` bytes that produced the
/// token. It is used only as an in-memory cache key; the raw file and the digest
/// are never logged or sent. Deriving it from the same snapshot removes the race
/// between reading auth and reading file metadata, and a content swap that
/// preserves the file timestamp still changes the key.
fn codex_auth_content_fingerprint(raw: &str) -> String {
    lowercase_hex(&Sha256::digest(raw.as_bytes()))
}

/// The ChatGPT access token, optional account id, and content fingerprint read
/// from one `auth.json` snapshot in this exact home. A missing or unreadable
/// file is a miss, never a fallback to another Profile's home.
struct CodexAuthSnapshot {
    access_token: String,
    account_id: Option<String>,
    content_fingerprint: String,
}

fn codex_chatgpt_auth_snapshot_in(home: &Path) -> Option<CodexAuthSnapshot> {
    let raw = std::fs::read_to_string(home.join("auth.json")).ok()?;
    let value: Value = serde_json::from_str(&raw).ok()?;
    let root = value.as_object()?;
    let tokens = root
        .get("tokens")
        .and_then(Value::as_object)
        .unwrap_or(root);
    let access_token = first_string(tokens, &["access_token", "accessToken", "token", "access"])?;
    let account_id = first_string(tokens, &["account_id", "accountId"])
        .or_else(|| first_string(root, &["account_id", "accountId"]));
    Some(CodexAuthSnapshot {
        access_token,
        account_id,
        content_fingerprint: codex_auth_content_fingerprint(&raw),
    })
}

/// Codex ChatGPT subscription windows from `/backend-api/wham/usage`, read from
/// one explicit config home. Prefer this over waiting for app-server
/// rate-limit snapshots so Agents UI can show 5h/1w while the agent is idle or
/// mid-turn.
///
/// The home is passed in rather than taken from the process environment: a
/// pre-launch reader must read the same account the spawn would use, and two
/// Profiles on one host must not share one cache slot.
pub async fn read_codex_chatgpt_usage_for_home(home: &Path, force: bool) -> Option<LlmUsage> {
    read_codex_usage_from_endpoint(home, force, CODEX_CHATGPT_USAGE_URL).await
}

// The production entrypoint fixes the provider URL. The private seam lets
// tests exercise HTTP/auth/cache behavior against loopback without real keys.
async fn read_codex_usage_from_endpoint(
    home: &Path,
    force: bool,
    endpoint: &str,
) -> Option<LlmUsage> {
    // Resolve the account snapshot before consulting the cache: a rotated
    // `auth.json` at the same path must not reuse the previous account's
    // reading, and a home without auth is a miss that must not touch another
    // account's slot.
    let snapshot = codex_chatgpt_auth_snapshot_in(home)?;
    let key = codex_quota_cache_key(home, &snapshot.content_fingerprint);
    if let Some(cached) = CODEX_CHATGPT_USAGE.hit_unless_forced(&key, force) {
        return cached;
    }
    let access_token = snapshot.access_token;
    let account_id = snapshot.account_id;

    let mut request = provider_client()
        .get(endpoint)
        .header(
            reqwest::header::AUTHORIZATION,
            format!("Bearer {access_token}"),
        )
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::USER_AGENT, "xmatrix-cli");
    if let Some(account_id) = account_id.as_deref() {
        request = request.header("ChatGPT-Account-Id", account_id);
    }

    let value = CODEX_CHATGPT_USAGE
        .fetch_json(&key, "codex", request)
        .await?;

    // The request may outlive an account switch at the same config home.
    // Reject that response before caching or returning it to the daemon; the
    // credential fingerprint stays local and is never part of the wire schema.
    if codex_chatgpt_auth_snapshot_in(home)?.content_fingerprint != snapshot.content_fingerprint {
        return None;
    }

    // This endpoint is the account-level quota authority. Restrict parsing to
    // its wham envelope rather than accepting any rate-limit-like nested
    // object that could resemble an app-server session snapshot.
    let mut usage = codex_wham_usage_from_value(&value);
    if let Some(usage) = usage.as_mut() {
        usage.quota_observed_at = super::observed_now();
    }
    CODEX_CHATGPT_USAGE.store(&key, usage.clone());
    usage
}

/// Backwards-compatible entry point used by the Codex runtime: resolve the
/// process `CODEX_HOME` (or `~/.codex`) exactly as before, then read that home.
pub async fn read_codex_chatgpt_usage(force: bool) -> Option<LlmUsage> {
    let home = codex_home_dir()?;
    read_codex_chatgpt_usage_for_home(&home, force).await
}

pub fn codex_wham_usage_from_value(value: &Value) -> Option<LlmUsage> {
    let mut best = LlmUsage::default();
    append_quota_usages(
        &mut best.quota_usages,
        codex_wham_quota_usages(value.as_object()?),
    );
    prefer_codex_quota_windows(&mut best.quota_usages);
    if best.quota_usages.is_some() {
        best.quota_source = Some("provider_api".to_string());
        best.quota_account = codex_wham_account(value);
    }
    if has_llm_usage(&best) {
        Some(best)
    } else {
        None
    }
}

/// Whether ChatGPT still serves the account, from the same `wham/usage` read:
/// `rate_limit.allowed` already accounts for credits and spend controls, and
/// `credits` is what a request draws on once the windows are used up.
fn codex_wham_account(value: &Value) -> Option<LlmQuotaAccount> {
    let allowed = value
        .pointer("/rate_limit/allowed")
        .and_then(Value::as_bool);
    let credits = value
        .get("credits")
        .and_then(Value::as_object)
        .and_then(|credits| {
            let unlimited = credits.get("unlimited").and_then(Value::as_bool) == Some(true);
            let has_credits = credits.get("has_credits").and_then(Value::as_bool) == Some(true);
            (has_credits || unlimited).then(|| LlmQuotaCredits {
                balance: credits
                    .get("balance")
                    .and_then(|balance| match balance {
                        Value::String(text) => text.trim().parse::<f64>().ok(),
                        other => other.as_f64(),
                    })
                    .filter(|balance| balance.is_finite() && *balance >= 0.0),
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
pub fn codex_wham_quota_usages(map: &serde_json::Map<String, Value>) -> Vec<LlmQuotaUsage> {
    if let Some(rate_limit) = map.get("rate_limit").and_then(Value::as_object) {
        return codex_wham_rate_limit_object(rate_limit);
    }
    if map.contains_key("primary_window") || map.contains_key("secondary_window") {
        return codex_wham_rate_limit_object(map);
    }
    Vec::new()
}

fn codex_wham_rate_limit_object(map: &serde_json::Map<String, Value>) -> Vec<LlmQuotaUsage> {
    if !map.contains_key("primary_window") && !map.contains_key("secondary_window") {
        return Vec::new();
    }
    let mut quotas = Vec::new();
    for key in ["primary_window", "secondary_window"] {
        let Some(window) = map.get(key).and_then(Value::as_object) else {
            continue;
        };
        if let Some(quota) = codex_wham_window_quota(window) {
            quotas.push(quota);
        }
    }
    quotas
}

fn codex_wham_window_quota(window: &serde_json::Map<String, Value>) -> Option<LlmQuotaUsage> {
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
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn provider_http_read_preserves_cache_time_and_rotated_account_binding() {
        use std::io::Write;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let endpoint = format!("http://{}/usage", listener.local_addr().unwrap());
        let home = unique_temp_home("http-rotation");
        std::fs::create_dir_all(&home).unwrap();
        let server_home = home.clone();
        let server = std::thread::spawn(move || {
            for (account, percent) in [("alpha", 100), ("beta", 20), ("gamma", 0), ("delta", 100)] {
                let (mut stream, headers) =
                    super::super::read_fixture_http_request(&listener, "provider request missing");
                assert!(headers.contains(&format!("authorization: bearer fixture-{account}\r\n")));
                assert!(headers.contains(&format!("chatgpt-account-id: {account}\r\n")));
                if account == "gamma" {
                    // Deterministically rotate after the old account's request
                    // arrives but before its apparently healthy response.
                    std::fs::write(
                        server_home.join("auth.json"),
                        r#"{"tokens":{"access_token":"fixture-delta","account_id":"delta"}}"#,
                    )
                    .unwrap();
                }
                let body = serde_json::json!({"rate_limit":{"primary_window":{
                    "used_percent":percent,"limit_window_seconds":18000,"reset_at":1900000000
                }}})
                .to_string();
                write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        let set_account = |account: &str| {
            std::fs::write(
                home.join("auth.json"),
                serde_json::json!({"tokens":{"access_token":format!("fixture-{account}"),
                "account_id":account}})
                .to_string(),
            )
            .unwrap()
        };
        set_account("alpha");
        let first = read_codex_usage_from_endpoint(&home, false, &endpoint)
            .await
            .unwrap();
        assert_eq!(first.quota_source.as_deref(), Some("provider_api"));
        assert_eq!(first.quota_usages.as_ref().unwrap()[0].percent, Some(100.0));
        assert!(first.quota_observed_at.is_some());
        let cached = read_codex_usage_from_endpoint(&home, false, &endpoint)
            .await
            .unwrap();
        assert_eq!(cached.quota_observed_at, first.quota_observed_at);
        set_account("beta");
        let second = read_codex_usage_from_endpoint(&home, false, &endpoint)
            .await
            .unwrap();
        assert_eq!(second.quota_usages.as_ref().unwrap()[0].percent, Some(20.0));
        set_account("gamma");
        assert!(
            read_codex_usage_from_endpoint(&home, false, &endpoint)
                .await
                .is_none(),
            "an in-flight response for the previous account must not escape"
        );
        let switched = read_codex_usage_from_endpoint(&home, false, &endpoint)
            .await
            .unwrap();
        assert_eq!(
            switched.quota_usages.as_ref().unwrap()[0].percent,
            Some(100.0)
        );
        server.join().unwrap();
        std::fs::remove_dir_all(home).unwrap();
    }

    fn unique_temp_home(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "xmatrix-codex-home-{name}-{}-{nanos}",
            std::process::id()
        ))
    }

    #[test]
    fn cache_key_separates_homes_and_accounts() {
        let a = PathBuf::from("accounts/alpha");
        let b = PathBuf::from("accounts/beta");
        assert_ne!(
            codex_quota_cache_key(&a, "account:1"),
            codex_quota_cache_key(&b, "account:1")
        );
        assert_ne!(
            codex_quota_cache_key(&a, "account:1"),
            codex_quota_cache_key(&a, "account:2")
        );
        assert_eq!(
            codex_quota_cache_key(&a, "account:1"),
            codex_quota_cache_key(&a, "account:1")
        );
    }

    #[test]
    fn content_fingerprint_tracks_the_snapshot() {
        let first = codex_auth_content_fingerprint(r#"{"tokens":{"access_token":"t1"}}"#);
        let same = codex_auth_content_fingerprint(r#"{"tokens":{"access_token":"t1"}}"#);
        let different = codex_auth_content_fingerprint(r#"{"tokens":{"access_token":"t2"}}"#);
        assert_eq!(first, same);
        assert_ne!(first, different);
        assert_eq!(first.len(), 64, "sha256 hex");
    }

    #[test]
    fn rotated_auth_json_changes_the_cache_key() {
        let home = unique_temp_home("rotated");
        std::fs::create_dir_all(&home).expect("home");
        std::fs::write(
            home.join("auth.json"),
            r#"{"tokens":{"access_token":"t1","account_id":"account-a"}}"#,
        )
        .expect("first auth");
        let first = codex_chatgpt_auth_snapshot_in(&home).expect("first snapshot");
        let first_key = codex_quota_cache_key(&home, &first.content_fingerprint);

        std::fs::write(
            home.join("auth.json"),
            r#"{"tokens":{"access_token":"t2","account_id":"account-b"}}"#,
        )
        .expect("second auth");
        let second = codex_chatgpt_auth_snapshot_in(&home).expect("second snapshot");
        let second_key = codex_quota_cache_key(&home, &second.content_fingerprint);

        assert_ne!(first_key, second_key);
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn same_path_same_mtime_different_account_is_isolated() {
        let home = unique_temp_home("same-mtime");
        std::fs::create_dir_all(&home).expect("home");
        let path = home.join("auth.json");
        std::fs::write(
            &path,
            r#"{"tokens":{"access_token":"t1","account_id":"account-a"}}"#,
        )
        .expect("first auth");
        let modified = std::fs::metadata(&path)
            .expect("metadata")
            .modified()
            .expect("mtime");
        let first = codex_chatgpt_auth_snapshot_in(&home).expect("first snapshot");

        // Replace the account while preserving the file timestamp: the
        // fingerprint must still change because it comes from the content
        // snapshot, not from metadata.
        {
            use std::io::Write as _;
            let mut file = std::fs::File::create(&path).expect("rewrite auth");
            file.write_all(br#"{"tokens":{"access_token":"t2","account_id":"account-b"}}"#)
                .expect("write auth");
            file.set_modified(modified).expect("restore mtime");
        }
        assert_eq!(
            std::fs::metadata(&path)
                .expect("metadata")
                .modified()
                .expect("mtime"),
            modified
        );
        let second = codex_chatgpt_auth_snapshot_in(&home).expect("second snapshot");

        assert_ne!(
            codex_quota_cache_key(&home, &first.content_fingerprint),
            codex_quota_cache_key(&home, &second.content_fingerprint)
        );
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn auth_snapshot_comes_only_from_the_given_home() {
        let empty = unique_temp_home("empty");
        let configured = unique_temp_home("configured");
        std::fs::create_dir_all(&empty).expect("empty home");
        std::fs::create_dir_all(&configured).expect("configured home");
        std::fs::write(
            configured.join("auth.json"),
            r#"{"tokens":{"access_token":"fixture-token","account_id":"fixture-account"}}"#,
        )
        .expect("auth fixture");

        // A home without auth.json is a miss and must not fall back to another
        // Profile's home (the fixture next to it).
        assert!(codex_chatgpt_auth_snapshot_in(&empty).is_none());
        let snapshot = codex_chatgpt_auth_snapshot_in(&configured).expect("configured snapshot");
        assert_eq!(snapshot.access_token, "fixture-token");
        assert_eq!(snapshot.account_id.as_deref(), Some("fixture-account"));

        std::fs::remove_dir_all(&empty).ok();
        std::fs::remove_dir_all(&configured).ok();
    }

    #[test]
    fn codex_wham_usage_extracts_primary_and_secondary_windows() {
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

        let quotas = super::super::assert_provider_window_labels(
            codex_wham_usage_from_value(&payload).unwrap(),
            &["5h", "1w"],
        );
        assert_eq!(quotas[0].window.as_deref(), Some("Codex"));
        assert_eq!(quotas[0].percent, Some(12.5));
        assert_eq!(quotas[0].reset_at.as_deref(), Some("1784012345"));
        assert_eq!(quotas[1].percent, Some(40.0));
        assert_eq!(quotas[1].reset_at.as_deref(), Some("1784487804"));
    }

    #[test]
    fn codex_wham_usage_keeps_whether_credits_still_serve_a_used_up_week() {
        let payload = serde_json::json!({
            "plan_type": "pro",
            "rate_limit": {
                "allowed": true,
                "limit_reached": true,
                "primary_window": { "used_percent": 100, "limit_window_seconds": 604800, "reset_at": 1791631680 }
            },
            "credits": { "has_credits": true, "unlimited": false, "balance": "137.5" },
            "spend_control": { "reached": false }
        });
        let usage = codex_wham_usage_from_value(&payload).unwrap();
        assert_eq!(usage.quota_usages.unwrap()[0].percent, Some(100.0));
        assert_eq!(
            usage.quota_account,
            Some(LlmQuotaAccount {
                allowed: Some(true),
                credits: Some(LlmQuotaCredits {
                    balance: Some(137.5),
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
            codex_wham_usage_from_value(&refused).unwrap().quota_account,
            Some(LlmQuotaAccount {
                allowed: Some(false),
                credits: None
            })
        );
    }

    #[test]
    fn codex_wham_usage_rejects_app_server_session_rate_limits() {
        // Session snapshots share a `rate_limit` wrapper but use primary/secondary
        // and minute windows. Accepting them made each Codex thread publish its own
        // meter and the Agents list jumped whenever another session heartbeated.
        let payload = serde_json::json!({
            "rate_limit": {
                "primary": { "usedPercent": 12, "windowDurationMins": 300 },
                "secondary": { "usedPercent": 34, "windowDurationMins": 10080 }
            }
        });
        assert!(codex_wham_usage_from_value(&payload).is_none());

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
        assert!(codex_wham_usage_from_value(&mixed).is_none());
    }

    #[test]
    fn codex_wham_usage_handles_weekly_only_primary_window() {
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

        let usage = codex_wham_usage_from_value(&payload).unwrap();
        let quotas = usage.quota_usages.unwrap();
        assert_eq!(quotas.len(), 1);
        assert_eq!(quotas[0].label.as_deref(), Some("1w"));
        assert_eq!(quotas[0].window.as_deref(), Some("Codex"));
        assert_eq!(quotas[0].percent, Some(40.0));
    }
}
