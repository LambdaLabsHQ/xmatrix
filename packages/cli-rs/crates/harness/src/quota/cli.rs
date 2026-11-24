//! Asking a harness's own CLI for its quota: finding the binary, gating on the
//! release that first answers the question, and the in-memory cache key of
//! the login a spawn of it would use.
//!
//! Readers built on this never open a provider credential file or keychain
//! item: the CLI resolves its own sign-in and answers through its documented
//! interface.

use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;

use crate::host::lowercase_hex;

/// A `major.minor.patch` CLI release.
pub(crate) type CliVersion = (u64, u64, u64);

const VERSION_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_VERSION_STDOUT_BYTES: usize = 4 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
struct BinaryFingerprint {
    modified: Option<SystemTime>,
    len: u64,
}

/// `--version` answers by binary path, dropped when the file changes (an
/// upgrade in place).
static VERSIONS: OnceLock<Mutex<HashMap<PathBuf, (BinaryFingerprint, CliVersion)>>> =
    OnceLock::new();
/// Version refusals already logged, so a refusal is said once per binary
/// and release rather than on every presence refresh.
static LOGGED_REFUSALS: OnceLock<Mutex<HashSet<(String, Option<CliVersion>)>>> = OnceLock::new();

fn binary_fingerprint(program: &Path) -> Option<BinaryFingerprint> {
    let metadata = std::fs::metadata(program).ok()?;
    Some(BinaryFingerprint {
        modified: metadata.modified().ok(),
        len: metadata.len(),
    })
}

/// The first `major.minor.patch` in `raw` (`"2.1.331 (Claude Code)"`,
/// `"opencode v2.4.1"`, `"agy 1.1.11"`).
pub(crate) fn parse_cli_semver(raw: &str) -> Option<CliVersion> {
    raw.split(|ch: char| !(ch.is_ascii_digit() || ch == '.'))
        .find_map(|token| {
            let mut parts = token.split('.');
            let major = parts.next()?.parse::<u64>().ok()?;
            let minor = parts.next()?.parse::<u64>().ok()?;
            let patch = parts.next()?.parse::<u64>().ok()?;
            if parts.next().is_some() {
                return None;
            }
            Some((major, minor, patch))
        })
}

/// A quiet child of `program`: no stdin, piped stdout/stderr, killed when
/// dropped, run from `cwd` when it exists, and never a console window.
pub(crate) fn probe_command(program: &Path, cwd: Option<&Path>) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(program);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(cwd) = cwd.filter(|path| path.is_dir()) {
        command.current_dir(cwd);
    }
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// The release `program --version` reports, cached while the binary is
/// unchanged.
pub(crate) async fn cli_version(program: &Path, cwd: Option<&Path>) -> Option<CliVersion> {
    let versions = VERSIONS.get_or_init(|| Mutex::new(HashMap::new()));
    let fingerprint = binary_fingerprint(program);
    if let Some(fingerprint) = fingerprint.as_ref()
        && let Some((_, version)) = versions
            .lock()
            .ok()?
            .get(program)
            .filter(|(seen, _)| seen == fingerprint)
    {
        return Some(*version);
    }
    let mut command = probe_command(program, cwd);
    command.arg("--version").stderr(Stdio::null());
    let mut child = command.spawn().ok()?;
    let stdout = child.stdout.take()?;
    let read = async {
        let mut bytes = Vec::new();
        let mut limited = stdout.take((MAX_VERSION_STDOUT_BYTES + 1) as u64);
        let (read, status) = tokio::join!(limited.read_to_end(&mut bytes), child.wait());
        read.ok()?;
        if !status.ok()?.success() || bytes.len() > MAX_VERSION_STDOUT_BYTES {
            return None;
        }
        parse_cli_semver(&String::from_utf8(bytes).ok()?)
    };
    let version = tokio::time::timeout(VERSION_TIMEOUT, read)
        .await
        .ok()
        .flatten()?;
    if let (Some(fingerprint), Ok(mut versions)) = (fingerprint, versions.lock()) {
        versions.insert(program.to_path_buf(), (fingerprint, version));
    }
    Some(version)
}

/// Whether `program` is at least `min`. A refusal (an older or unreadable
/// release) is logged once per binary and version, naming the release the
/// reader needs.
pub(crate) async fn cli_at_least(
    program: &Path,
    cwd: Option<&Path>,
    min: CliVersion,
    tool: &str,
) -> bool {
    let version = cli_version(program, cwd).await;
    version_at_least(&program.display().to_string(), version, min, tool)
}

/// Whether `version` of the `tool` at `source` is at least `min`; a refusal
/// is logged once per source and version.
pub(crate) fn version_at_least(
    source: &str,
    version: Option<CliVersion>,
    min: CliVersion,
    tool: &str,
) -> bool {
    if version.is_some_and(|version| version >= min) {
        return true;
    }
    let first = LOGGED_REFUSALS
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .is_ok_and(|mut logged| logged.insert((source.to_string(), version)));
    if first {
        let found = version.map_or_else(
            || "an unknown release".to_string(),
            |(major, minor, patch)| format!("{major}.{minor}.{patch}"),
        );
        eprintln!(
            "xmatrix: {tool} quota needs {tool} {}.{}.{} or later; {source} is {found}, so its quota is not read",
            min.0, min.1, min.2
        );
    }
    false
}

fn find_in_paths(path_var: &OsStr, name: &str) -> Option<PathBuf> {
    #[cfg(windows)]
    let candidates = [
        format!("{name}.exe"),
        format!("{name}.cmd"),
        format!("{name}.bat"),
        name.to_string(),
    ];
    #[cfg(not(windows))]
    let candidates = [name.to_string()];
    std::env::split_paths(path_var)
        .filter(|dir| !dir.as_os_str().is_empty())
        .find_map(|dir| {
            candidates
                .iter()
                .map(|candidate| dir.join(candidate))
                .find(|path| path.is_file())
        })
}

/// `name` on `PATH`, then the first of `fallbacks` that exists (the
/// installers' own locations, for a daemon started without them on `PATH`).
pub(crate) fn resolve_program(name: &str, fallbacks: &[PathBuf]) -> Option<PathBuf> {
    std::env::var_os("PATH")
        .and_then(|path| find_in_paths(&path, name))
        .or_else(|| fallbacks.iter().find(|path| path.is_file()).cloned())
}

/// The in-memory cache key of the login a spawn would use: `tag`, the home it
/// runs in, and a one-way fingerprint of each login override set in `env`
/// (`<KEY>` itself for `paths`, whose value is a location, not a secret).
/// Never logged or sent.
pub(crate) fn login_cache_key(
    tag: &str,
    home: Option<&Path>,
    override_keys: &[&str],
    paths: &[&str],
    env: &dyn Fn(&str) -> Option<String>,
) -> String {
    let mut parts = vec![
        tag.to_string(),
        home.map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_default(),
    ];
    for key in override_keys {
        let Some(value) = env(key)
            .map(|raw| raw.trim().to_string())
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        if paths.contains(key) {
            parts.push(format!("{key}={value}"));
        } else {
            parts.push(format!(
                "{key}#{}",
                lowercase_hex(&Sha256::digest(value.as_bytes()))
            ));
        }
    }
    parts.join("\u{0}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semver_is_the_first_dotted_triple() {
        assert_eq!(
            parse_cli_semver("2.1.331 (Claude Code)\n"),
            Some((2, 1, 331))
        );
        assert_eq!(parse_cli_semver("opencode v2.4.1"), Some((2, 4, 1)));
        assert_eq!(parse_cli_semver("1.19.6"), Some((1, 19, 6)));
        assert_eq!(parse_cli_semver("build 7"), None);
    }

    #[test]
    fn login_cache_key_holds_no_raw_override_value() {
        let env = |key: &str| match key {
            "TOKEN" => Some("secret-token".to_string()),
            "CONFIG_DIR" => Some("/opt/config".to_string()),
            _ => None,
        };
        let key = login_cache_key(
            "process",
            Some(Path::new("/home/u")),
            &["TOKEN", "CONFIG_DIR", "UNSET"],
            &["CONFIG_DIR"],
            &env,
        );
        assert!(!key.contains("secret-token"), "{key}");
        assert!(key.contains("CONFIG_DIR=/opt/config"), "{key}");
        assert!(!key.contains("UNSET"), "{key}");
        let without = login_cache_key(
            "process",
            Some(Path::new("/home/u")),
            &["TOKEN"],
            &[],
            &|_| None,
        );
        assert_ne!(key, without);
    }
}
