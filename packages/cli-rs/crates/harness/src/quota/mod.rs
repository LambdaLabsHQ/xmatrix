//! Account-quota probes: what each provider says this login has left.
//!
//! Every reader returns `Option<LlmUsage>` whose quota facts carry
//! `quota_source = "provider_api"` and a `quota_observed_at` stamp, or `None`
//! when the provider has no usable answer. A reader never invents a reading:
//! a missing credential, transport failure, HTTP error, or unrecognised body is
//! `None`, remembered briefly so a flapping provider is not hammered.
//!
//! [`read`] is the single entrypoint; the per-provider modules also expose
//! their readers and pure `*_from_value` parsers for callers that already hold
//! a provider payload.

use std::path::PathBuf;

use crate::usage::LlmUsage;

pub mod antigravity;
mod cache;
pub mod claude;
pub mod codex;
pub mod cursor;
pub mod deepseek;
pub mod grant;
pub mod grok;

pub use grant::{GrantedRead, SignInReadGrant};
pub mod opencode;
pub mod windows;
pub mod zai;

/// Global opt-out environment variable that disables all local provider quota
/// probes (both daemon pre-launch probes and live session polling) so xMatrix
/// does not read local provider credential stores or query provider usage APIs.
pub const QUOTA_PROBES_DISABLE_ENV: &str = "XMATRIX_DISABLE_QUOTA_PROBES";

/// Whether `value` turns on a boolean disable flag (`1`, `true`, `yes`, `on`).
pub fn is_flag_enabled_value(value: Option<&str>) -> bool {
    value.is_some_and(|raw| {
        matches!(
            raw.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
}

/// Whether all provider quota probes are disabled in the given environment view.
pub fn quota_probes_disabled_in(env: impl Fn(&str) -> Option<String>) -> bool {
    is_flag_enabled_value(env(QUOTA_PROBES_DISABLE_ENV).as_deref())
}

/// Whether all provider quota probes are disabled in the current process
/// environment (`XMATRIX_DISABLE_QUOTA_PROBES`).
pub fn quota_probes_disabled() -> bool {
    quota_probes_disabled_in(|key| std::env::var(key).ok())
}

pub(crate) fn observed_provider_quotas(
    quotas: Vec<crate::usage::LlmQuotaUsage>,
) -> Option<LlmUsage> {
    if quotas.is_empty() {
        return None;
    }
    let usage = LlmUsage {
        quota_source: Some("provider_api".to_string()),
        quota_usages: Some(quotas),
        quota_observed_at: observed_now(),
        ..LlmUsage::default()
    };
    crate::usage::has_llm_usage(&usage).then_some(usage)
}

/// A provider whose account quota this crate can read.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Provider {
    /// Google Antigravity (`agy`) Gemini and Claude/GPT model pools.
    Antigravity,
    /// Claude Code / Claude.ai subscription 5h and 1w windows.
    Claude,
    /// Codex ChatGPT subscription windows (app-server `account/rateLimits/read`).
    Codex,
    /// Cursor Agent billing-cycle and Auto/API buckets.
    Cursor,
    /// DeepSeek prepaid API balance (an amount, not a window).
    DeepSeek,
    /// Grok Build credits (weekly or monthly).
    Grok,
    /// OpenCode Go 5h/1w/1mo windows.
    OpenCode,
    /// Z.ai / Zhipu coding-plan windows.
    Zai,
}

/// Which login a read is bound to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Account {
    /// The login the current process environment resolves (explicit token
    /// variables first, then the provider CLI's default files). Supported by
    /// every provider.
    Process,
    /// The login stored in one explicit provider config home (`CODEX_HOME`,
    /// a Grok home). Never consults the process environment, so a pre-launch
    /// probe reads exactly the account a spawn with that home would bill.
    /// Supported by [`Provider::Codex`] and [`Provider::Grok`].
    Home(PathBuf),
    /// The provider CLI's default login, ignoring token/config overrides in
    /// the environment. Supported by [`Provider::Antigravity`],
    /// [`Provider::Claude`] (keychain, then `~/.claude/.credentials.json`), and
    /// [`Provider::Cursor`].
    DefaultLogin,
}

/// How to read one provider's quota.
#[derive(Clone, Debug)]
pub struct ReadOptions {
    pub account: Account,
    /// Bypass the success/error TTL cache and ask the provider now.
    pub force: bool,
}

/// Read one provider's account quota.
///
/// Returns `None` when the provider has no reading for that account, when
/// the provider does not support the requested [`Account`] binding, or when
/// the provider is read only under a grant
/// ([`Provider::reads_sign_in_only_with_grant`], read through [`read_granted`]).
pub async fn read(provider: Provider, options: ReadOptions) -> Option<LlmUsage> {
    if quota_probes_disabled() {
        return None;
    }
    let force = options.force;
    match (provider, options.account) {
        (Provider::Antigravity, Account::Process) => {
            antigravity::read_antigravity_quota_usage(force).await
        }
        (Provider::Antigravity, Account::DefaultLogin) => {
            antigravity::read_antigravity_quota_usage_for_default_account(force).await
        }
        (Provider::Claude, Account::Process) => {
            claude::read_claude_oauth_rate_limit_usage(force).await
        }
        (Provider::Claude, Account::DefaultLogin) => {
            claude::read_claude_oauth_usage_for_default_account(force).await
        }
        (Provider::Codex, Account::Process) => codex::read_codex_account_usage(None, force).await,
        (Provider::Codex, Account::Home(home)) => {
            codex::read_codex_account_usage(Some(&home), force).await
        }
        // Read only under a grant: see [`read_granted`].
        (Provider::Cursor, _) => None,
        (Provider::DeepSeek, Account::Process) => deepseek::read_deepseek_balance(force).await,
        (Provider::Grok, Account::Process) => grok::read_grok_build_billing_usage(force).await,
        (Provider::Grok, Account::Home(home)) => {
            grok::read_grok_build_billing_usage_for_home(&home, force).await
        }
        (Provider::OpenCode, Account::Process) => opencode::read_opencode_zen_usage(force).await,
        (Provider::Zai, Account::Process) => zai::read_zai_coding_plan_quota_usage(force).await,
        (
            Provider::Antigravity
            | Provider::Claude
            | Provider::DeepSeek
            | Provider::OpenCode
            | Provider::Zai,
            Account::Home(_),
        )
        | (
            Provider::Codex
            | Provider::DeepSeek
            | Provider::Grok
            | Provider::OpenCode
            | Provider::Zai,
            Account::DefaultLogin,
        ) => None,
    }
}

/// Read one provider's account quota under the owner's grant to read its
/// local sign-in. A provider that needs no grant ignores it; one that does
/// opens no credential source without it ([`GrantedRead::Closed`]).
pub async fn read_granted(
    provider: Provider,
    options: ReadOptions,
    grant: Option<&SignInReadGrant>,
) -> GrantedRead {
    match provider {
        Provider::Cursor => cursor::read_cursor_period_usage(options.force, grant).await,
        _ => GrantedRead::Read {
            usage: read(provider, options).await,
            bound: None,
        },
    }
}

impl Provider {
    /// Whether this provider has no official quota interface, so its quota is
    /// read from the harness's own local sign-in, and only under a grant.
    pub fn reads_sign_in_only_with_grant(self) -> bool {
        matches!(self, Provider::Cursor)
    }
}

/// The current instant as RFC 3339, the `quota_observed_at` stamp.
fn observed_now() -> Option<String> {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .ok()
}

#[cfg(test)]
pub(crate) fn read_fixture_http_request(
    listener: &std::net::TcpListener,
    missing_request: &str,
) -> (std::net::TcpStream, String) {
    use std::io::Read;
    use std::time::{Duration, Instant};
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut stream = loop {
        match listener.accept() {
            Ok((stream, _)) => break stream,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                assert!(Instant::now() < deadline, "{missing_request}");
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(error) => panic!("accept: {error}"),
        }
    };
    // macOS may inherit the listener's nonblocking mode before the request arrives.
    stream.set_nonblocking(false).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut request = Vec::new();
    while !request.ends_with(b"\r\n\r\n") {
        let mut byte = [0];
        assert_eq!(stream.read(&mut byte).unwrap(), 1);
        request.push(byte[0]);
        assert!(request.len() < 8192);
    }
    let headers = String::from_utf8(request).unwrap().to_ascii_lowercase();
    // Drain any declared request body before writing and closing: on Windows,
    // closing a TCP socket with unread bytes in its receive buffer sends RST
    // and aborts the client's response read.
    if let Some(content_length) = headers.lines().find_map(|line| {
        line.strip_prefix("content-length:")
            .and_then(|value| value.trim().parse::<usize>().ok())
    }) {
        assert!(content_length <= 65_536);
        let mut body = vec![0u8; content_length];
        stream.read_exact(&mut body).unwrap();
    }
    (stream, headers)
}

/// What a credential-file reader returns is the provider's quota answer only:
/// no token, account id, other field of the login file, the in-memory
/// fingerprint of its bytes, or the config home it sits in. Every quota fact
/// the daemon reports to the Hub is copied from this reading, so a value
/// absent here cannot reach the Hub.
#[cfg(test)]
fn assert_reading_holds_nothing_of_the_login(
    usage: &LlmUsage,
    home: &std::path::Path,
    file_values: &[&str],
) {
    use sha2::Digest;
    let raw = std::fs::read_to_string(home.join("auth.json")).unwrap();
    let fingerprint = crate::host::lowercase_hex(&sha2::Sha256::digest(raw.as_bytes()));
    let home = home.to_string_lossy();
    let wire = serde_json::to_string(usage).unwrap();
    for needle in file_values
        .iter()
        .copied()
        .chain([fingerprint.as_str(), home.as_ref()])
    {
        assert!(!wire.contains(needle), "{needle} leaked into {wire}");
    }
}

/// Write `script` to `path` as an executable stand-in for a provider CLI.
#[cfg(all(test, unix))]
pub(crate) fn write_test_executable(path: &std::path::Path, script: &str) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(path, script).expect("write test executable");
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
}

#[cfg(test)]
fn assert_provider_window_labels(
    usage: LlmUsage,
    labels: &[&str],
) -> Vec<crate::usage::LlmQuotaUsage> {
    assert_eq!(usage.quota_source.as_deref(), Some("provider_api"));
    let quotas = usage.quota_usages.unwrap();
    assert_eq!(quotas.len(), labels.len());
    for (quota, label) in quotas.iter().zip(labels) {
        assert_eq!(quota.label.as_deref(), Some(*label));
    }
    quotas
}

#[cfg(test)]
mod tests {
    use super::*;

    fn quota_labels(quotas: &[crate::usage::LlmQuotaUsage]) -> Vec<String> {
        quotas
            .iter()
            .map(|quota| {
                format!(
                    "{}={}%",
                    quota.label.as_deref().unwrap_or("?"),
                    quota.percent.unwrap_or(-1.0)
                )
            })
            .collect()
    }

    #[test]
    fn global_quota_probe_opt_out_flag_parses_truthy_and_falsy_values() {
        for truthy in ["1", "true", "TRUE", "yes", "On", "  1  "] {
            assert!(
                quota_probes_disabled_in(|key| {
                    (key == QUOTA_PROBES_DISABLE_ENV).then(|| truthy.to_string())
                }),
                "{truthy:?}"
            );
            assert!(
                antigravity::is_quota_probe_disabled_in(|key| {
                    (key == QUOTA_PROBES_DISABLE_ENV).then(|| truthy.to_string())
                }),
                "global flag must also disable Antigravity: {truthy:?}"
            );
        }
        for falsy in ["", "0", "false", "no", "off"] {
            assert!(
                !quota_probes_disabled_in(|key| {
                    (key == QUOTA_PROBES_DISABLE_ENV).then(|| falsy.to_string())
                }),
                "{falsy:?}"
            );
        }
        assert!(!quota_probes_disabled_in(|_| None));
    }

    #[tokio::test]
    async fn unsupported_account_bindings_read_nothing() {
        let home = std::env::temp_dir().join("xmatrix-harness-unsupported-home");
        for provider in [
            Provider::Antigravity,
            Provider::Claude,
            Provider::Cursor,
            Provider::OpenCode,
            Provider::Zai,
        ] {
            let options = ReadOptions {
                account: Account::Home(home.clone()),
                force: true,
            };
            assert!(read(provider, options).await.is_none(), "{provider:?}");
        }
        for provider in [
            Provider::Codex,
            Provider::Grok,
            Provider::OpenCode,
            Provider::Zai,
        ] {
            let options = ReadOptions {
                account: Account::DefaultLogin,
                force: true,
            };
            assert!(read(provider, options).await.is_none(), "{provider:?}");
        }
    }

    #[test]
    fn live_e2e_codex_and_grok_quota_readers() {
        if std::env::var("XMATRIX_LIVE_QUOTA_E2E").ok().as_deref() != Some("1") {
            eprintln!("skip live e2e (set XMATRIX_LIVE_QUOTA_E2E=1)");
            return;
        }
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio runtime");
        let codex = rt.block_on(codex::read_codex_account_usage(None, true));
        let grok = rt.block_on(grok::read_grok_build_billing_usage(true));
        let codex =
            codex.expect("codex account/rateLimits/read should resolve with the local sign-in");
        let grok = grok.expect("grok billing usage should resolve with local auth");
        let codex_q = codex.quota_usages.as_ref().expect("codex quotas");
        let grok_q = grok.quota_usages.as_ref().expect("grok quotas");
        assert!(
            codex_q.iter().any(|q| {
                let label = q.label.as_deref().unwrap_or("");
                (label == "1w" || label == "5h") && q.percent.is_some()
            }),
            "codex quotas={codex_q:?}"
        );
        assert!(
            grok_q.iter().any(|q| {
                let label = q.label.as_deref().unwrap_or("");
                (label == "1mo" || label == "1w") && q.percent.is_some()
            }),
            "grok quotas={grok_q:?}"
        );
        eprintln!(
            "LIVE_E2E_OK codex={:?} grok={:?}",
            quota_labels(codex_q),
            quota_labels(grok_q)
        );
    }
}
