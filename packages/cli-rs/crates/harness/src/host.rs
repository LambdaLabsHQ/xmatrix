//! Process-local helpers the provider readers share.

use std::path::PathBuf;

/// The HTTP client every provider read uses.
///
/// reqwest is built with `rustls-no-provider` to avoid the AWS-LC native
/// build, so the ring provider is installed here before the first client is
/// made. Installing is idempotent and a provider the host already installed
/// wins, which keeps this crate usable outside the xMatrix binary (including
/// its own unit-test executable).
pub(crate) fn provider_client() -> reqwest::Client {
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::new()
}

/// The user's home directory as the harness CLIs resolve it
/// (`USERPROFILE` on Windows, then `HOME`).
pub fn home_dir_path() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

/// Lowercase hex of a digest; used only for in-memory cache keys.
pub(crate) fn lowercase_hex(bytes: &[u8]) -> String {
    const CHARS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(CHARS[(byte >> 4) as usize] as char);
        out.push(CHARS[(byte & 0x0f) as usize] as char);
    }
    out
}

/// Read a generic-password item from the macOS login keychain.
///
/// Goes through `/usr/bin/security` — the binary Claude Code and Cursor Agent
/// store their items with — so those item ACLs already trust it and no GUI
/// prompt appears. Only call this for items known to be stored that way; an
/// item without that trust raises a password prompt (Copilot does). The
/// timeout (with `kill_on_drop`) keeps an unexpected prompt from stalling
/// presence updates.
#[cfg(target_os = "macos")]
pub(crate) async fn macos_keychain_password(
    service: &str,
    account: Option<&str>,
) -> Option<String> {
    const KEYCHAIN_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

    let mut command = tokio::process::Command::new("/usr/bin/security");
    command.args(["find-generic-password", "-s", service]);
    if let Some(account) = account {
        command.args(["-a", account]);
    }
    command
        .arg("-w")
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let output = tokio::time::timeout(KEYCHAIN_READ_TIMEOUT, command.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout).ok()
}

#[cfg(not(target_os = "macos"))]
pub(crate) async fn macos_keychain_password(
    _service: &str,
    _account: Option<&str>,
) -> Option<String> {
    None
}
