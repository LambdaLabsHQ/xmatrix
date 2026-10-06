//! Drives real `git` against the real helper binary.
//!
//! `git credential fill` runs the configured helpers and parses their answers
//! exactly as a fetch or push would, without touching the network. That makes
//! the one part of this path that is otherwise hard to check -- whether Git and
//! the helper actually agree -- testable on any machine.
//!
//! It matters because the failure is silent: a helper that declines makes Git
//! fall through to whatever the host has configured, so on a developer machine
//! with a GitHub login already present, "working" and "broken" look the same.

use std::io::{Read as _, Write as _};
use std::net::TcpListener;
use std::process::{Command, Stdio};
use std::thread;

/// A stand-in for the daemon broker: hands back one token, and records what it
/// was asked for so the test can check the request as well as the answer.
struct FakeBroker {
    url: String,
    requests: std::sync::mpsc::Receiver<String>,
}

fn start_fake_broker(response_body: &'static str, status: &'static str) -> FakeBroker {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
    let url = format!("http://{}", listener.local_addr().unwrap());
    let (tx, requests) = std::sync::mpsc::channel();
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            let mut buffer = [0_u8; 4096];
            let read = stream.read(&mut buffer).unwrap_or(0);
            let _ = tx.send(String::from_utf8_lossy(&buffer[..read]).to_string());
            let _ = stream.write_all(
                format!(
                    "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{response_body}",
                    response_body.len()
                )
                .as_bytes(),
            );
        }
    });
    FakeBroker { url, requests }
}

/// Built exactly as the daemon builds it, so the test covers the real string
/// rather than a convenient one. Git runs a `!` helper through a shell, and on
/// Windows that shell rejects native paths.
fn helper_command() -> String {
    xmatrix_cli_core::git_credential::git_credential_helper_command(std::path::Path::new(env!(
        "CARGO_BIN_EXE_xmatrix"
    )))
}

fn git_available() -> bool {
    Command::new("git")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

/// Ask Git to fill a credential, with our helper configured the way the daemon
/// configures it for a run that holds a grant.
fn git_credential_fill(broker_url: &str, capability: &str, request: &str) -> String {
    fill_git_credential(broker_url, Some(capability), true, request)
}

fn fill_git_credential(
    broker_url: &str,
    capability: Option<&str>,
    use_http_path: bool,
    request: &str,
) -> String {
    let helper = helper_command();
    let mut command = Command::new("git");
    command
        .args(["-c", "credential.helper="])
        .args(["-c", &format!("credential.helper=!{helper}")]);
    if use_http_path {
        command.args(["-c", "credential.useHttpPath=true"]);
    }
    if let Some(capability) = capability {
        command.env("XMATRIX_GIT_CREDENTIAL_CAPABILITY", capability);
    } else {
        command.env_remove("XMATRIX_GIT_CREDENTIAL_CAPABILITY");
    }
    command
        .args(["credential", "fill"])
        .env("XMATRIX_DAEMON_AUTH_URL", broker_url)
        // Prevent interactive fallback when the helper declines.
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "true")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().expect("git credential fill should start");
    child
        .stdin
        .as_mut()
        .expect("stdin")
        .write_all(request.as_bytes())
        .expect("write credential request");
    let output = child.wait_with_output().expect("git should finish");
    if !output.stderr.is_empty() {
        eprintln!(
            "fixture Git/helper diagnostic: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    String::from_utf8_lossy(&output.stdout).to_string()
}

#[test]
fn git_uses_the_token_the_daemon_hands_back() {
    if !git_available() {
        return;
    }
    let broker = start_fake_broker(r#"{"token":"ghs_end_to_end"}"#, "200 OK");

    let filled = git_credential_fill(
        &broker.url,
        "cap-test",
        "protocol=https\nhost=github.com\npath=LambdaLabsHQ/xmatrix.git\n\n",
    );

    assert!(
        filled.contains("username=x-access-token"),
        "git did not take the username from the helper: {filled}"
    );
    assert!(
        filled.contains("password=ghs_end_to_end"),
        "git did not take the token from the helper: {filled}"
    );

    let asked = broker
        .requests
        .recv_timeout(std::time::Duration::from_secs(10))
        .expect("the helper should have asked the broker");
    assert!(
        asked.contains(r#"{"repository":"LambdaLabsHQ/xmatrix"}"#),
        "the helper must ask for exactly the repository git named: {asked}"
    );
    assert!(
        asked
            .to_ascii_lowercase()
            .contains("x-xmatrix-git-credential-capability: cap-test"),
        "the run's capability must identify the request: {asked}"
    );
}

#[test]
fn git_gets_nothing_when_the_daemon_refuses() {
    if !git_available() {
        return;
    }
    let broker = start_fake_broker(r#"{"error":"forbidden"}"#, "403 Forbidden");

    let filled = git_credential_fill(
        &broker.url,
        "cap-test",
        "protocol=https\nhost=github.com\npath=OtherOrg/secrets.git\n\n",
    );

    assert!(
        !filled.contains("password=ghs"),
        "a refused repository must not produce a credential: {filled}"
    );
}

#[test]
fn a_run_without_a_capability_leaves_git_to_its_own_devices() {
    if !git_available() {
        return;
    }
    let broker = start_fake_broker(r#"{"token":"ghs_should_not_be_used"}"#, "200 OK");

    // No capability in the environment: the helper has no grant to speak for and
    // must not reach the broker at all.
    let filled = fill_git_credential(
        &broker.url,
        None,
        true,
        "protocol=https\nhost=github.com\npath=LambdaLabsHQ/xmatrix.git\n\n",
    );

    assert!(
        !filled.contains("ghs_should_not_be_used"),
        "a run holding no grant must not receive a token: {filled}"
    );
    assert!(
        broker
            .requests
            .recv_timeout(std::time::Duration::from_millis(500))
            .is_err(),
        "the helper must not contact the broker without a capability"
    );
}

#[test]
fn git_is_not_asked_for_a_repository_when_the_path_is_withheld() {
    if !git_available() {
        return;
    }
    let broker = start_fake_broker(r#"{"token":"ghs_should_not_be_used"}"#, "200 OK");

    // Same configuration minus useHttpPath. Git then sends only the host, and
    // the helper must decline rather than ask for an installation-wide token.
    let filled = fill_git_credential(
        &broker.url,
        Some("cap-test"),
        false,
        "protocol=https\nhost=github.com\npath=LambdaLabsHQ/xmatrix.git\n\n",
    );

    assert!(
        !filled.contains("ghs_should_not_be_used"),
        "without the repository path no credential may be produced: {filled}"
    );
    assert!(
        broker
            .requests
            .recv_timeout(std::time::Duration::from_millis(500))
            .is_err(),
        "the helper must not ask the broker for a token it cannot scope"
    );
}
