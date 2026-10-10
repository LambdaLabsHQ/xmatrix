//! The `gh` an Agent Run reaches (docs/design/conversation-activity.md §3.6).
//!
//! `gh` has no hook of its own, so the daemon puts this executable first on the
//! Run's PATH under the name `gh`. Every invocation runs the real `gh`
//! unchanged. After a `gh pr create` that succeeds, the pull request it printed
//! is subscribed to the Run's conversation with `xmatrix channel subscribe`,
//! whichever harness ran the command, and the Agent reads the outcome in the
//! command's own output.

use std::ffi::{OsStr, OsString};
use std::io::{IsTerminal as _, Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};

use crate::runtime_channel_activity::pull_request_urls;

/// The `gh` this entrypoint stands in front of, resolved when the Run started.
const GH_REAL_ENV: &str = "XMATRIX_GH_REAL";
const CONVERSATION_ENV: &str = "XMATRIX_AUTO_JOIN_CHANNEL_ID";
/// `gh pr create` prints one URL; more output than this is not read for one.
const MAX_PRINTED_BYTES: usize = 64 * 1024;

fn entrypoint_directory() -> PathBuf {
    xmatrix_cli_core::config::config_dir().join("run-tools")
}

fn entrypoint_name() -> &'static str {
    if cfg!(windows) { "gh.exe" } else { "gh" }
}

fn named_gh(path: &Path) -> bool {
    path.file_stem()
        .and_then(OsStr::to_str)
        .is_some_and(|stem| stem.eq_ignore_ascii_case("gh"))
}

/// `gh pr create`, or its alias `gh pr new`, wherever its flags sit.
fn opens_pull_request(args: &[OsString]) -> bool {
    args.windows(2)
        .any(|pair| pair[0] == "pr" && (pair[1] == "create" || pair[1] == "new"))
}

/// PATH with the entrypoint directory first and nowhere else.
fn entrypoint_path(directory: &Path, base: &OsStr) -> Option<OsString> {
    let rest = std::env::split_paths(base).filter(|path| path != directory);
    std::env::join_paths(std::iter::once(directory.to_path_buf()).chain(rest)).ok()
}

/// The first `gh` on `path` that is not this entrypoint.
fn gh_behind(directory: &Path, path: &OsStr) -> Option<PathBuf> {
    let rest =
        std::env::join_paths(std::env::split_paths(path).filter(|dir| dir != directory)).ok()?;
    let cwd = std::env::current_dir().ok()?;
    which::which_in("gh", Some(rest), cwd).ok()
}

fn install(cli: &Path, directory: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(directory)?;
    let entrypoint = directory.join(entrypoint_name());
    let temporary = directory.join(format!("gh.{}.tmp", uuid::Uuid::new_v4()));
    #[cfg(unix)]
    {
        if std::fs::read_link(&entrypoint).is_ok_and(|target| target == cli) {
            return Ok(());
        }
        std::os::unix::fs::symlink(cli, &temporary)?;
    }
    #[cfg(not(unix))]
    {
        // The entrypoint is a copy of this CLI; a newer CLI replaces it.
        let current = std::fs::metadata(cli)?;
        if std::fs::metadata(&entrypoint).is_ok_and(|installed| {
            installed.len() == current.len() && installed.modified().ok() >= current.modified().ok()
        }) {
            return Ok(());
        }
        if std::fs::hard_link(cli, &temporary).is_err() {
            std::fs::copy(cli, &temporary)?;
        }
    }
    std::fs::rename(&temporary, &entrypoint).inspect_err(|_| {
        let _ = std::fs::remove_file(&temporary);
    })
}

/// Put the `gh` entrypoint first on a Run's PATH. A machine without `gh`, or
/// one where the entrypoint cannot be written, leaves the Run as it was.
pub(crate) fn apply_gh_entrypoint(command: &mut Command, cli: &Path) {
    // Unit tests spawn the test runner, which has no `gh` entrypoint.
    if cfg!(test) || cli.starts_with("/proc") {
        return;
    }
    let Some(base) = command
        .get_envs()
        .find(|(key, _)| key.to_string_lossy().eq_ignore_ascii_case("PATH"))
        .and_then(|(_, value)| value.map(OsStr::to_os_string))
        .or_else(|| std::env::var_os("PATH"))
    else {
        return;
    };
    let directory = entrypoint_directory();
    let Some(real) = gh_behind(&directory, &base) else {
        return;
    };
    let Some(path) = entrypoint_path(&directory, &base) else {
        return;
    };
    if let Err(error) = install(cli, &directory) {
        eprintln!("failed to install the gh entrypoint: {error}");
        return;
    }
    command.env(GH_REAL_ENV, real).env("PATH", path);
}

fn real_gh() -> Option<PathBuf> {
    let own = std::env::current_exe()
        .ok()
        .and_then(|exe| std::fs::canonicalize(exe).ok());
    let named = std::env::var_os(GH_REAL_ENV)
        .map(PathBuf::from)
        .filter(|path| path.is_absolute() && path.is_file());
    let real = named.or_else(|| gh_behind(&entrypoint_directory(), &std::env::var_os("PATH")?))?;
    (std::fs::canonicalize(&real).ok() != own).then_some(real)
}

fn exit_code(status: std::io::Result<ExitStatus>) -> i32 {
    match status {
        Ok(status) => status.code().unwrap_or(1),
        Err(error) => {
            eprintln!("gh: {error}");
            126
        }
    }
}

/// Subscribe the Run's conversation and say what happened where the Agent
/// reads it: the command's own output.
fn subscribe(conversation: &str, url: &str) {
    let retry = format!("xmatrix channel subscribe {conversation} {url}");
    // Named by the daemon; this process's own image may be the entrypoint copy.
    let Some(cli) = std::env::var_os(xmatrix_cli_agent::XMATRIX_BIN_ENV) else {
        eprintln!("xmatrix: {url} is not subscribed to this conversation. Run `{retry}`.");
        return;
    };
    let reported = Command::new(cli)
        .args(["channel", "subscribe", conversation, url])
        .stdin(Stdio::null())
        .output();
    match reported {
        Ok(output) if output.status.success() => eprintln!(
            "xmatrix: {url} is subscribed to this conversation; its CI verdict, reviews, comments and merge arrive here."
        ),
        Ok(output) => eprintln!(
            "xmatrix: {url} is not subscribed to this conversation: {}\nRun `{retry}` to try again.",
            String::from_utf8_lossy(&output.stderr).trim()
        ),
        Err(error) => eprintln!(
            "xmatrix: {url} is not subscribed to this conversation: {error}\nRun `{retry}` to try again."
        ),
    }
}

fn run_gh(args: &[OsString]) -> i32 {
    let Some(real) = real_gh() else {
        eprintln!("gh: not found on this machine");
        return 127;
    };
    let mut command = Command::new(real);
    command.args(args);
    let conversation = std::env::var(CONVERSATION_ENV)
        .ok()
        .filter(|conversation| !conversation.trim().is_empty());
    // A terminal keeps `gh`'s prompts: its output is then not ours to read.
    let (Some(conversation), true) = (
        conversation,
        opens_pull_request(args) && !std::io::stdout().is_terminal(),
    ) else {
        return exit_code(command.status());
    };
    let mut child = match command.stdout(Stdio::piped()).spawn() {
        Ok(child) => child,
        Err(error) => return exit_code(Err(error)),
    };
    let mut printed = Vec::new();
    if let Some(mut output) = child.stdout.take() {
        let mut stdout = std::io::stdout();
        let mut chunk = [0_u8; 4096];
        while let Ok(read) = output.read(&mut chunk) {
            if read == 0 {
                break;
            }
            let _ = stdout.write_all(&chunk[..read]);
            let _ = stdout.flush();
            if printed.len() < MAX_PRINTED_BYTES {
                printed.extend_from_slice(&chunk[..read]);
            }
        }
    }
    let status = child.wait();
    if status.as_ref().is_ok_and(ExitStatus::success) {
        for url in pull_request_urls(&String::from_utf8_lossy(&printed)) {
            subscribe(&conversation, &url);
        }
    }
    exit_code(status)
}

/// Called before Clap: `Some(exit code)` when this process was started as `gh`.
pub fn maybe_run_gh() -> Option<i32> {
    let invoked = std::env::args_os().next()?;
    if !named_gh(Path::new(&invoked)) && !std::env::current_exe().is_ok_and(|exe| named_gh(&exe)) {
        return None;
    }
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    Some(run_gh(&args))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(words: &[&str]) -> Vec<OsString> {
        words.iter().map(OsString::from).collect()
    }

    #[test]
    fn only_creating_a_pull_request_is_read() {
        assert!(opens_pull_request(&args(&["pr", "create", "--fill"])));
        assert!(opens_pull_request(&args(&["pr", "new", "-R", "acme/app"])));
        assert!(!opens_pull_request(&args(&["pr", "view", "7"])));
        assert!(!opens_pull_request(&args(&["issue", "create"])));
        assert!(!opens_pull_request(&args(&["pr"])));
    }

    #[test]
    fn the_entrypoint_directory_is_first_on_the_path_once() {
        let directory = Path::new("/config/run-tools");
        let base =
            std::env::join_paths(["/usr/bin", "/config/run-tools", "/bin"].map(PathBuf::from))
                .expect("path");
        let path = entrypoint_path(directory, &base).expect("path");
        assert_eq!(
            std::env::split_paths(&path).collect::<Vec<_>>(),
            ["/config/run-tools", "/usr/bin", "/bin"].map(PathBuf::from)
        );
    }

    #[test]
    fn the_entrypoint_is_named_gh_and_never_its_own_target() {
        assert!(named_gh(Path::new("/config/run-tools/gh")));
        assert!(named_gh(Path::new("/config/run-tools/GH.exe")));
        assert!(!named_gh(Path::new("/usr/local/bin/xmatrix")));
        let root = std::env::temp_dir().join(format!("xmatrix-gh-{}", uuid::Uuid::new_v4()));
        let directory = root.join("run-tools");
        let cli = root.join("xmatrix");
        std::fs::create_dir_all(&root).expect("root");
        std::fs::write(&cli, b"cli").expect("cli");
        install(&cli, &directory).expect("install");
        install(&cli, &directory).expect("install again");
        assert_eq!(
            std::fs::read(directory.join(entrypoint_name())).expect("entrypoint"),
            b"cli"
        );
        // A PATH holding only the entrypoint has no `gh` behind it.
        assert_eq!(gh_behind(&directory, directory.as_os_str()), None);
        let _ = std::fs::remove_dir_all(root);
    }
}
