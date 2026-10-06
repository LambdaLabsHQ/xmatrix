//! Claude Code OAuth credential sourcing for the subscription quota reader.
//!
//! Claude Code keeps its OAuth credentials in the OS keychain on macOS and refreshes
//! them there; `~/.claude/.credentials.json` is only a snapshot that goes stale (its
//! `expiresAt` can be days in the past while the live token is fine). Reading only the
//! file therefore leaves the Agents panel with no 5h/1w meters at all.

use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

/// Treat tokens expiring within this window as already stale.
const EXPIRY_BUFFER_MS: i64 = 60_000;

/// Parse one Claude credentials JSON blob and return its access token when still valid.
pub(crate) fn access_token_from_credentials_json(raw: &str) -> Option<String> {
    let value: Value = serde_json::from_str(raw).ok()?;
    let oauth = value
        .get("claudeAiOauth")
        .or_else(|| value.get("claude_ai_oauth"))?;
    let token = oauth
        .get("accessToken")
        .or_else(|| oauth.get("access_token"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?
        .to_string();

    if let Some(expires_at) = oauth
        .get("expiresAt")
        .or_else(|| oauth.get("expires_at"))
        .and_then(|value| {
            value
                .as_i64()
                .or_else(|| value.as_u64().and_then(|n| i64::try_from(n).ok()))
                .or_else(|| value.as_f64().map(|n| n as i64))
                .or_else(|| value.as_str()?.trim().parse::<i64>().ok())
        })
    {
        // expiresAt is epoch milliseconds for Claude Code credentials.
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .ok()?
            .as_millis() as i64;
        if expires_at > 0 && expires_at <= now_ms + EXPIRY_BUFFER_MS {
            return None;
        }
    }

    Some(token)
}

/// Read the login-keychain credentials Claude Code writes on macOS.
async fn keychain_credentials_json() -> Option<String> {
    crate::host::macos_keychain_password("Claude Code-credentials", None).await
}

/// Resolve a usable Claude OAuth access token: explicit env token, then the
/// keychain copy Claude Code keeps fresh, then the on-disk snapshot.
pub(crate) async fn claude_oauth_access_token() -> Option<String> {
    if let Ok(token) = std::env::var("CLAUDE_CODE_OAUTH_TOKEN") {
        let trimmed = token.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }

    if let Some(token) = keychain_credentials_json()
        .await
        .as_deref()
        .and_then(access_token_from_credentials_json)
    {
        return Some(token);
    }

    let path = crate::host::home_dir_path()?
        .join(".claude")
        .join(".credentials.json");
    let raw = std::fs::read_to_string(path).ok()?;
    access_token_from_credentials_json(&raw)
}

/// The login Claude Code uses when nothing in its environment overrides it: the
/// keychain copy, then the default `~/.claude/.credentials.json` snapshot.
pub(crate) struct ClaudeDefaultAccountCredential {
    pub(crate) access_token: String,
    /// Where the credential came from plus a one-way fingerprint of its exact
    /// bytes. An in-memory cache key only; never logged or sent.
    pub(crate) cache_key: String,
}

/// Resolve the default Claude login without consulting `CLAUDE_CODE_OAUTH_TOKEN`
/// or `CLAUDE_CONFIG_DIR`. The pre-launch probe calls this only after proving a
/// spawn of its target would see neither, so both resolve the same account.
pub(crate) async fn claude_default_account_credential() -> Option<ClaudeDefaultAccountCredential> {
    use sha2::{Digest, Sha256};
    let fingerprint = |raw: &str| crate::host::lowercase_hex(&Sha256::digest(raw.as_bytes()));
    if let Some(raw) = keychain_credentials_json().await
        && let Some(access_token) = access_token_from_credentials_json(&raw)
    {
        return Some(ClaudeDefaultAccountCredential {
            access_token,
            cache_key: format!("keychain\u{0}{}", fingerprint(&raw)),
        });
    }
    let path = crate::host::home_dir_path()?
        .join(".claude")
        .join(".credentials.json");
    let raw = std::fs::read_to_string(&path).ok()?;
    let access_token = access_token_from_credentials_json(&raw)?;
    Some(ClaudeDefaultAccountCredential {
        access_token,
        cache_key: format!("{}\u{0}{}", path.to_string_lossy(), fingerprint(&raw)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claude_credentials_blob(expires_at_ms: Option<i64>) -> String {
        let mut oauth = serde_json::json!({ "accessToken": "sk-ant-oat01-test" });
        if let Some(expires_at) = expires_at_ms {
            oauth["expiresAt"] = serde_json::json!(expires_at);
        }
        serde_json::json!({ "claudeAiOauth": oauth }).to_string()
    }

    fn epoch_ms_from_now(offset_ms: i64) -> i64 {
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        now_ms + offset_ms
    }

    #[test]
    fn claude_credentials_snapshot_yields_token_while_unexpired() {
        let raw = claude_credentials_blob(Some(epoch_ms_from_now(3_600_000)));
        assert_eq!(
            access_token_from_credentials_json(&raw).as_deref(),
            Some("sk-ant-oat01-test")
        );

        // No expiry recorded: keep the token rather than dropping the quota meters.
        let raw = claude_credentials_blob(None);
        assert!(access_token_from_credentials_json(&raw).is_some());
    }

    #[test]
    fn claude_credentials_snapshot_is_rejected_once_stale() {
        // The macOS failure mode: ~/.claude/.credentials.json lags days behind the
        // keychain copy Claude Code actually refreshes.
        let raw = claude_credentials_blob(Some(epoch_ms_from_now(-2 * 24 * 3_600_000)));
        assert!(access_token_from_credentials_json(&raw).is_none());

        // Inside the refresh buffer counts as stale too.
        let raw = claude_credentials_blob(Some(epoch_ms_from_now(10_000)));
        assert!(access_token_from_credentials_json(&raw).is_none());
    }
}
