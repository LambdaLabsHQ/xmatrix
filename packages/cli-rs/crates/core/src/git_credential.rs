//! Git credential helper backed by the Space's GitHub connector.
//!
//! Git asks this helper for a password instead of reading one from the host, so
//! a machine that runs agents for several Spaces never needs a GitHub login of
//! its own. Each answer is a short-lived token for exactly the repository Git
//! named, which is what keeps two Spaces on one machine out of each other's
//! repositories.
//!
//! The parsing here is deliberately strict. Git only sends the repository path
//! when `credential.useHttpPath=true` is set on the invocation; without it we
//! would know the host but not the repository, and the only credential we could
//! ask for would cover the whole installation. Answering nothing is the correct
//! outcome in that case -- a widened token would still work, which is exactly
//! why it would go unnoticed.

use std::collections::BTreeMap;
use std::time::Duration;

use serde::Deserialize;

use crate::daemon_auth::{load_broker_state, normalize_loopback_broker_url};
use crate::error::{CliError, Result};

tokio::task_local! {
    static SCOPED_GIT_CREDENTIAL_CAPABILITY: String;
}

/// The username GitHub expects alongside an installation token.
pub const INSTALLATION_TOKEN_USERNAME: &str = "x-access-token";

pub const GIT_CREDENTIAL_PATH: &str = "/git/credential";
pub const GIT_CREDENTIAL_CAPABILITY_HEADER: &str = "x-xmatrix-git-credential-capability";
/// Issued per run, so it travels in that run's environment rather than any file.
pub const GIT_CREDENTIAL_CAPABILITY_ENV: &str = "XMATRIX_GIT_CREDENTIAL_CAPABILITY";
const DAEMON_AUTH_URL_ENV: &str = "XMATRIX_DAEMON_AUTH_URL";

const GITHUB_HOST: &str = "github.com";

/// What Git asked for, once we have decided we can answer it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CredentialRequest {
    pub owner: String,
    pub repo: String,
}

impl CredentialRequest {
    pub fn repository(&self) -> String {
        format!("{}/{}", self.owner, self.repo)
    }
}

/// Why a request produced no credential. Each of these is a normal outcome that
/// leaves Git to fall back on its own machinery, not an error to report.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CredentialDeclined {
    /// Not GitHub over HTTPS; nothing here applies.
    NotGitHub,
    /// Git did not send a repository path, so any token we asked for would be
    /// broader than the operation being performed.
    MissingRepositoryPath,
}

pub type CredentialDecision = std::result::Result<CredentialRequest, CredentialDeclined>;

/// Parse the `key=value` block Git writes to a helper's stdin.
///
/// Git terminates the block with a blank line and may send a key more than
/// once; last value wins, which matches how Git itself reads helper output.
pub fn parse_credential_input(input: &str) -> BTreeMap<String, String> {
    let mut values = BTreeMap::new();
    for line in input.lines() {
        if line.is_empty() {
            break;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        values.insert(key.trim().to_string(), value.trim().to_string());
    }
    values
}

/// Decide whether this request is one we can answer, and for which repository.
pub fn decide_credential(values: &BTreeMap<String, String>) -> CredentialDecision {
    let protocol = values.get("protocol").map(String::as_str).unwrap_or("");
    let host = values.get("host").map(String::as_str).unwrap_or("");
    if protocol != "https" || !host_is_github(host) {
        return Err(CredentialDeclined::NotGitHub);
    }

    let path = values.get("path").map(String::as_str).unwrap_or("");
    parse_repository_path(path).ok_or(CredentialDeclined::MissingRepositoryPath)
}

/// GitHub is reached at exactly `github.com`; a port suffix is still the same
/// host. Anything else -- an enterprise install, a look-alike -- is not ours to
/// answer for.
fn host_is_github(host: &str) -> bool {
    let host = host.split_once(':').map(|(name, _)| name).unwrap_or(host);
    host.eq_ignore_ascii_case(GITHUB_HOST)
}

/// Extract `owner/repo` from the path Git sends, which looks like
/// `LambdaLabsHQ/xmatrix.git` or `LambdaLabsHQ/xmatrix`.
fn parse_repository_path(path: &str) -> Option<CredentialRequest> {
    let trimmed = path.trim_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    let mut segments = trimmed.split('/');
    let owner = segments.next()?;
    let repo = segments.next()?;
    // A deeper path is not a repository root and must not be guessed at.
    if segments.next().is_some() {
        return None;
    }
    let repo = repo.strip_suffix(".git").unwrap_or(repo);
    if !is_path_segment(owner) || !is_path_segment(repo) {
        return None;
    }
    Some(CredentialRequest {
        owner: owner.to_string(),
        repo: repo.to_string(),
    })
}

fn is_path_segment(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

/// Render the answer Git expects on stdout.
pub fn format_credential_output(token: &str) -> String {
    format!("username={INSTALLATION_TOKEN_USERNAME}\npassword={token}\n")
}

/// How Git must be told to run this binary as a credential helper.
pub fn git_credential_helper_command(executable: &std::path::Path) -> String {
    // Git runs a `!`-prefixed helper through a shell, and on Windows that shell
    // is sh, where backslashes are escape characters. A native path there is
    // silently not runnable: Git reports no credential and falls back exactly as
    // if no helper were configured. Forward slashes are understood on both
    // platforms; the quotes carry paths containing spaces.
    let path = executable.display().to_string().replace('\\', "/");
    format!("\"{path}\" git-credential")
}

/// The `-c` arguments that make Git ask this helper and nothing else.
///
/// Applied only where a run actually holds a grant. Two of these three are
/// load-bearing in ways that are easy to lose:
///
/// - The empty `credential.helper` first clears whatever the host configured --
///   a keychain, `gh`'s helper, a stored credential. Without it Git may satisfy
///   the request from the machine's own GitHub login, and a run would reach
///   repositories its Space was never given.
/// - `credential.useHttpPath` is what makes Git send the repository at all.
///   Without it the helper sees only `github.com` and cannot ask for a token
///   narrower than the whole installation.
pub fn git_credential_config_args(helper_command: &str) -> Vec<String> {
    vec![
        "-c".to_string(),
        "credential.helper=".to_string(),
        "-c".to_string(),
        format!("credential.helper=!{helper_command}"),
        "-c".to_string(),
        "credential.useHttpPath=true".to_string(),
    ]
}

/// Run `fut` with a grant that Git child processes of this task should use.
///
/// The daemon process itself must not take a process-wide capability: concurrent
/// spawns for different Spaces would then share one grant. A task-local value
/// is inherited only by git/helper children launched from this spawn.
pub async fn with_scoped_capability<F>(capability: Option<String>, fut: F) -> F::Output
where
    F: std::future::Future,
{
    match capability {
        Some(capability) => {
            SCOPED_GIT_CREDENTIAL_CAPABILITY
                .scope(capability, fut)
                .await
        }
        None => fut.await,
    }
}

/// Grant for this spawn task, else the process environment (child helper path).
pub fn scoped_or_env_capability() -> Option<String> {
    if let Ok(capability) = SCOPED_GIT_CREDENTIAL_CAPABILITY.try_with(Clone::clone)
        && !capability.trim().is_empty()
    {
        return Some(capability);
    }
    std::env::var(GIT_CREDENTIAL_CAPABILITY_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// The operations Git invokes a helper with.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CredentialOperation {
    Get,
    Store,
    Erase,
}

pub fn parse_credential_operation(value: &str) -> Result<CredentialOperation> {
    match value.trim() {
        "get" => Ok(CredentialOperation::Get),
        "store" => Ok(CredentialOperation::Store),
        "erase" => Ok(CredentialOperation::Erase),
        other => Err(CliError::Auth(format!(
            "Unsupported git credential operation: {other}"
        ))),
    }
}

#[derive(Deserialize)]
struct RepositoryTokenResponse {
    token: Option<String>,
}

/// Ask the local daemon for a token covering one repository.
///
/// The capability arrives through this process's environment, issued to this
/// run alone. It is deliberately not read from the machine-wide broker state
/// file: that file is shared by every run on the host, so a capability stored
/// there would be a capability every run holds, and the Space each run is
/// confined to would stop meaning anything.
///
/// Returns `Ok(None)` whenever the daemon simply cannot answer -- no capability
/// issued, daemon not running, too old to know this route, or unwilling to grant
/// this repository. Git then falls back to its own credential machinery, which
/// is the same behaviour as having no helper installed.
pub async fn request_repository_token(repository: &str) -> Result<Option<String>> {
    let Some(capability) = std::env::var(GIT_CREDENTIAL_CAPABILITY_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    let Some(url) = broker_url_for_git_credentials().await? else {
        return Ok(None);
    };
    request_repository_token_from(&url, &capability, repository).await
}

/// The broker address may come from this run's environment, the same way the
/// existing auth broker is handed to agents. The machine-wide state file is the
/// fallback for callers inside the daemon itself.
async fn broker_url_for_git_credentials() -> Result<Option<String>> {
    if let Ok(url) = std::env::var(DAEMON_AUTH_URL_ENV)
        && !url.trim().is_empty()
    {
        return Ok(Some(url.trim().to_string()));
    }
    Ok(load_broker_state().await?.map(|state| state.url))
}

async fn request_repository_token_from(
    broker_url: &str,
    capability: &str,
    repository: &str,
) -> Result<Option<String>> {
    if capability.len() > 256
        || !capability
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(CliError::Auth(
            "Invalid local daemon git credential capability".into(),
        ));
    }
    let Some(url) = normalize_loopback_broker_url(broker_url) else {
        return Err(CliError::Auth(
            "Invalid local daemon auth broker URL".into(),
        ));
    };
    let address = url
        .strip_prefix("http://")
        .ok_or_else(|| CliError::Auth("Invalid local daemon auth broker URL".into()))?;

    let body = serde_json::json!({ "repository": repository }).to_string();
    let request = format!(
        "POST {GIT_CREDENTIAL_PATH} HTTP/1.1\r\nhost: {address}\r\n{GIT_CREDENTIAL_CAPABILITY_HEADER}: {capability}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    );
    let Some(response) = crate::daemon_host::send_loopback_http(
        address,
        request.as_bytes(),
        b"",
        Duration::from_secs(10),
        None,
    )
    .await
    else {
        return Ok(None);
    };

    let response = String::from_utf8_lossy(&response);
    let status = crate::daemon_host::http_response_status(&response)
        .ok_or_else(|| CliError::Auth("Malformed local daemon credential response".into()))?;
    if !(200..300).contains(&status) {
        return Ok(None);
    }
    let payload = response
        .split_once("\r\n\r\n")
        .map(|(_, body)| body)
        .ok_or_else(|| CliError::Auth("Malformed local daemon credential response".into()))?;
    let payload: RepositoryTokenResponse = serde_json::from_str(payload)?;
    Ok(payload
        .token
        .map(|token| token.trim().to_string())
        .filter(|token| !token.is_empty()))
}

#[cfg(test)]
mod tests {
    mod http_fixture {
        include!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/support/http_accept_fixture.rs"
        ));
    }

    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn input(lines: &[&str]) -> BTreeMap<String, String> {
        parse_credential_input(&format!("{}\n", lines.join("\n")))
    }

    #[test]
    fn parses_the_block_git_writes_and_stops_at_the_blank_line() {
        let values = parse_credential_input(
            "protocol=https\nhost=github.com\npath=LambdaLabsHQ/xmatrix.git\n\nignored=yes\n",
        );
        assert_eq!(values.get("protocol").map(String::as_str), Some("https"));
        assert_eq!(values.get("host").map(String::as_str), Some("github.com"));
        assert_eq!(values.get("ignored"), None);
    }

    #[test]
    fn answers_for_the_exact_repository_git_named() {
        let decision = decide_credential(&input(&[
            "protocol=https",
            "host=github.com",
            "path=LambdaLabsHQ/xmatrix.git",
        ]));
        let request = decision.expect("github https requests are answerable");
        assert_eq!(request.repository(), "LambdaLabsHQ/xmatrix");
    }

    #[test]
    fn a_path_without_the_git_suffix_is_the_same_repository() {
        let decision = decide_credential(&input(&[
            "protocol=https",
            "host=github.com",
            "path=LambdaLabsHQ/xmatrix",
        ]));
        assert_eq!(
            decision.expect("path without suffix").repository(),
            "LambdaLabsHQ/xmatrix"
        );
    }

    #[test]
    fn declines_when_git_did_not_send_the_repository_path() {
        // This is the credential.useHttpPath=false case. Answering would mean
        // asking for a token wider than the push being performed.
        let decision = decide_credential(&input(&["protocol=https", "host=github.com"]));
        assert_eq!(decision, Err(CredentialDeclined::MissingRepositoryPath));
    }

    #[test]
    fn declines_paths_that_are_not_a_repository_root() {
        for path in ["LambdaLabsHQ", "LambdaLabsHQ/xmatrix/extra", "/", ""] {
            let decision = decide_credential(&input(&[
                "protocol=https",
                "host=github.com",
                &format!("path={path}"),
            ]));
            assert_eq!(
                decision,
                Err(CredentialDeclined::MissingRepositoryPath),
                "path {path:?} must not resolve to a repository"
            );
        }
    }

    #[test]
    fn declines_hosts_that_are_not_github() {
        for host in ["gitlab.com", "github.com.evil.test", "ghe.internal"] {
            let decision = decide_credential(&input(&[
                "protocol=https",
                &format!("host={host}"),
                "path=LambdaLabsHQ/xmatrix.git",
            ]));
            assert_eq!(
                decision,
                Err(CredentialDeclined::NotGitHub),
                "host {host:?} must not be answered for"
            );
        }
    }

    #[test]
    fn declines_plain_http_even_on_github() {
        let decision = decide_credential(&input(&[
            "protocol=http",
            "host=github.com",
            "path=LambdaLabsHQ/xmatrix.git",
        ]));
        assert_eq!(decision, Err(CredentialDeclined::NotGitHub));
    }

    #[test]
    fn a_host_with_a_port_is_still_github() {
        let decision = decide_credential(&input(&[
            "protocol=https",
            "host=github.com:443",
            "path=LambdaLabsHQ/xmatrix.git",
        ]));
        assert!(decision.is_ok());
    }

    #[test]
    fn output_uses_the_username_github_expects_for_installation_tokens() {
        assert_eq!(
            format_credential_output("ghs_example"),
            "username=x-access-token\npassword=ghs_example\n"
        );
    }

    #[tokio::test]
    async fn the_broker_request_carries_the_capability_and_only_the_repository() {
        let (address, server) = http_fixture::spawn_single_request_server(|mut stream, request| async move {
            let body = r#"{"token":"ghs_from_daemon"}"#;
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            request
        }).await;

        let token = request_repository_token_from(
            &format!("http://{address}"),
            "grant-test",
            "LambdaLabsHQ/xmatrix",
        )
        .await
        .unwrap();
        assert_eq!(token.as_deref(), Some("ghs_from_daemon"));

        let request = server.await.unwrap();
        assert!(request.starts_with("POST /git/credential HTTP/1.1"));
        assert!(
            request
                .to_ascii_lowercase()
                .contains("x-xmatrix-git-credential-capability: grant-test")
        );
        assert!(request.contains(r#"{"repository":"LambdaLabsHQ/xmatrix"}"#));
        // The Space belongs to the grant the daemon holds. If the caller could
        // name one, a run could reach a Space it has nothing to do with.
        assert!(
            !request.contains("spaceId") && !request.contains("channelId"),
            "the request must carry nothing that selects a Space: {request}"
        );
    }

    #[tokio::test]
    async fn a_daemon_that_refuses_produces_no_credential_rather_than_an_error() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = vec![0_u8; 4096];
            let _ = stream.read(&mut request).await.unwrap();
            let body = r#"{"error":"repository not granted"}"#;
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 403 Forbidden\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        });

        let token = request_repository_token_from(
            &format!("http://{address}"),
            "grant-test",
            "OtherOrg/secrets",
        )
        .await
        .unwrap();
        assert_eq!(token, None, "Git must fall back, not fail outright");
    }

    #[tokio::test]
    async fn a_capability_that_is_not_an_opaque_token_is_rejected_outright() {
        let result =
            request_repository_token_from("http://127.0.0.1:1", "not a token", "a/b").await;
        assert!(result.is_err());
    }

    #[test]
    fn only_the_three_git_operations_are_accepted() {
        assert_eq!(
            parse_credential_operation("get").unwrap(),
            CredentialOperation::Get
        );
        assert_eq!(
            parse_credential_operation("store").unwrap(),
            CredentialOperation::Store
        );
        assert_eq!(
            parse_credential_operation("erase").unwrap(),
            CredentialOperation::Erase
        );
        assert!(parse_credential_operation("approve").is_err());
    }

    #[tokio::test]
    async fn a_scoped_grant_is_visible_only_inside_that_task() {
        let before = scoped_or_env_capability();
        let inside = with_scoped_capability(Some("cap-spawn".into()), async {
            scoped_or_env_capability()
        })
        .await;
        assert_eq!(inside.as_deref(), Some("cap-spawn"));
        assert_eq!(scoped_or_env_capability(), before);
    }
}
