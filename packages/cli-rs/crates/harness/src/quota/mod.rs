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

mod cache;
pub mod claude;
pub mod codex;
pub mod cursor;
pub mod grok;
pub mod kimi;
pub mod opencode;
pub mod refresh;
pub mod windows;
pub mod zai;

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
    /// Claude Code / Claude.ai subscription 5h and 1w windows.
    Claude,
    /// Codex ChatGPT subscription windows (`wham/usage`).
    Codex,
    /// Cursor Agent billing-cycle and Auto/API buckets.
    Cursor,
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
    /// the environment. Supported by [`Provider::Claude`] (keychain, then
    /// `~/.claude/.credentials.json`) and [`Provider::Cursor`].
    DefaultLogin,
}

/// How to read one provider's quota.
#[derive(Clone, Debug)]
pub struct ReadOptions {
    pub account: Account,
    /// Bypass the success/error TTL cache and ask the provider now.
    pub force: bool,
}

impl ReadOptions {
    /// The process login, honouring the cache.
    pub fn process() -> Self {
        Self {
            account: Account::Process,
            force: false,
        }
    }
}

/// Read one provider's account quota.
///
/// Returns `None` when the provider has no reading for that account, or when
/// the provider does not support the requested [`Account`] binding.
pub async fn read(provider: Provider, options: ReadOptions) -> Option<LlmUsage> {
    let force = options.force;
    match (provider, options.account) {
        (Provider::Claude, Account::Process) => {
            claude::read_claude_oauth_rate_limit_usage(force).await
        }
        (Provider::Claude, Account::DefaultLogin) => {
            claude::read_claude_oauth_usage_for_default_account(force).await
        }
        (Provider::Codex, Account::Process) => codex::read_codex_chatgpt_usage(force).await,
        (Provider::Codex, Account::Home(home)) => {
            codex::read_codex_chatgpt_usage_for_home(&home, force).await
        }
        (Provider::Cursor, Account::Process | Account::DefaultLogin) => {
            cursor::read_cursor_period_usage(force).await
        }
        (Provider::Grok, Account::Process) => grok::read_grok_build_billing_usage(force).await,
        (Provider::Grok, Account::Home(home)) => {
            grok::read_grok_build_billing_usage_for_home(&home, force).await
        }
        (Provider::OpenCode, Account::Process) => opencode::read_opencode_zen_usage(force).await,
        (Provider::Zai, Account::Process) => zai::read_zai_coding_plan_quota_usage(force).await,
        (
            Provider::Claude | Provider::Cursor | Provider::OpenCode | Provider::Zai,
            Account::Home(_),
        )
        | (
            Provider::Codex | Provider::Grok | Provider::OpenCode | Provider::Zai,
            Account::DefaultLogin,
        ) => None,
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
    (
        stream,
        String::from_utf8(request).unwrap().to_ascii_lowercase(),
    )
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

    #[tokio::test]
    async fn unsupported_account_bindings_read_nothing() {
        let home = std::env::temp_dir().join("xmatrix-harness-unsupported-home");
        for provider in [
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
        let codex = rt.block_on(codex::read_codex_chatgpt_usage(true));
        let grok = rt.block_on(grok::read_grok_build_billing_usage(true));
        let codex = codex.expect("codex wham usage should resolve with local auth");
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
