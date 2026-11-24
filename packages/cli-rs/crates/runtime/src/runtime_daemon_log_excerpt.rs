//! The daemon log excerpt a person previews before handing a conversation to
//! xMatrix support (docs/cross-space-read-grants.md#support-handoffs). Only a
//! bounded recent tail of this daemon's own log is read, and it is redacted
//! here, on the machine, before anything leaves it: the same redaction the
//! Desktop App's daemon failure card applies (apps/desktop/src/daemon-failure.ts).

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;

use regex::Regex;
use xmatrix_cli_core::machine_daemon_connection::MachineLogExcerptOutcome;

/// The protocol's `SUPPORT_HANDOFF_LOG_EXCERPT_MAX`, in characters.
const EXCERPT_MAX_CHARS: usize = 16_000;
/// The most recent lines kept from each source.
const TAIL_LINES: usize = 200;
/// The most read from the end of each log file.
const TAIL_BYTES: u64 = 64 * 1024;
const JOURNAL_TIMEOUT: Duration = Duration::from_secs(10);

static ANSI: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]").expect("ANSI pattern"));
static USER_DIRECTORY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(/Users/|/home/|[A-Za-z]:\\Users\\)[^/\\\s]+").expect("user directory pattern")
});
static EMAIL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[A-Za-z0-9_.+-]+@[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)+").expect("email pattern")
});
static URL_QUERY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(https?://[^\s?#]+)[?#]\S*").expect("URL query pattern"));
static SECRET_VALUE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)\b(bearer|token|secret|password|key)(["']?\s*[:=]\s*["']?|\s+)[^\s"',;]+"#)
        .expect("secret value pattern")
});
static TOKEN_LIKE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[A-Za-z0-9_\-+/=]{32,}").expect("token-like pattern"));

/// One line as it may leave this machine: terminal colors and control
/// characters dropped, then the home directory, user directories, email
/// addresses, URL queries and fragments, secret values and anything shaped
/// like a token or key replaced.
fn redact_line(line: &str, home: &str) -> String {
    let plain = ANSI.replace_all(line, "");
    let plain: String = plain
        .chars()
        .map(|c| if c == '\t' { ' ' } else { c })
        .filter(|c| !c.is_control())
        .collect();
    let mut redacted = if home.is_empty() {
        plain
    } else {
        plain.replace(home, "~")
    };
    redacted = USER_DIRECTORY.replace_all(&redacted, "${1}…").into_owned();
    redacted = EMAIL.replace_all(&redacted, "<email>").into_owned();
    redacted = URL_QUERY.replace_all(&redacted, "${1}?…").into_owned();
    redacted = SECRET_VALUE
        .replace_all(&redacted, "${1}${2}…")
        .into_owned();
    redacted = TOKEN_LIKE.replace_all(&redacted, "…").into_owned();
    redacted.trim().to_string()
}

/// The last `TAIL_LINES` non-empty lines of `text`, each redacted, within
/// `max_chars` (the oldest lines go first).
fn redact_tail(text: &str, home: &str, max_chars: usize) -> String {
    let home = home.trim_end_matches(['/', '\\']);
    let lines: Vec<String> = text
        .lines()
        .map(|line| redact_line(line, home))
        .filter(|line| !line.is_empty())
        .collect();
    let mut kept: Vec<&str> = Vec::new();
    let mut used = 0;
    for line in lines.iter().rev().take(TAIL_LINES) {
        let size = line.chars().count() + 1;
        if used + size > max_chars {
            break;
        }
        used += size;
        kept.push(line);
    }
    kept.reverse();
    kept.join("\n")
}

/// The last `TAIL_BYTES` of a regular log file, or nothing when it is absent,
/// empty or not a plain file.
fn file_tail(path: &Path) -> Option<String> {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() == 0 {
        return None;
    }
    let mut file = std::fs::File::open(path).ok()?;
    let start = metadata.len().saturating_sub(TAIL_BYTES);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::new();
    file.take(TAIL_BYTES).read_to_end(&mut bytes).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    // A tail that starts mid-line drops the partial first line.
    let text = if start > 0 {
        text.split_once('\n').map_or("", |(_, rest)| rest)
    } else {
        &text
    };
    Some(text.to_string())
}

/// The log files a daemon of this machine writes, by the name shown above each
/// section: launchd's on macOS, and the one an update-started daemon appends to.
fn log_files(home: Option<&Path>, config_dir: &Path) -> Vec<(String, PathBuf)> {
    let mut files = Vec::new();
    if cfg!(target_os = "macos")
        && let Some(home) = home
    {
        let logs = home.join("Library").join("Logs");
        for name in ["xmatrix-daemon.err.log", "xmatrix-daemon.log"] {
            files.push((name.to_string(), logs.join(name)));
        }
    }
    for name in ["daemon.err", "daemon.out"] {
        files.push((format!("logs/{name}"), config_dir.join("logs").join(name)));
    }
    files
}

/// The systemd user journal of the daemon's unit, when systemd runs it.
async fn journal_tail() -> Option<String> {
    if !cfg!(target_os = "linux")
        || xmatrix_cli_update::recorded_daemon_service_manager().as_deref() != Some("systemd")
    {
        return None;
    }
    let lines = TAIL_LINES.to_string();
    let mut command = tokio::process::Command::new("journalctl");
    command
        .args([
            "--user",
            "-u",
            xmatrix_cli_update::SYSTEMD_UNIT,
            "-n",
            &lines,
        ])
        .args(["--no-pager", "-o", "short-iso"])
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    let output = tokio::time::timeout(JOURNAL_TIMEOUT, command.output())
        .await
        .ok()?
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Each source's redacted tail under its name, sharing the excerpt bound
/// equally, in the order given.
fn excerpt_of(sources: Vec<(String, String)>, home: &str) -> Option<String> {
    let sources: Vec<(String, String)> = sources
        .into_iter()
        .filter(|(_, text)| !text.trim().is_empty())
        .collect();
    if sources.is_empty() {
        return None;
    }
    let share = EXCERPT_MAX_CHARS / sources.len();
    let sections: Vec<String> = sources
        .into_iter()
        .filter_map(|(name, text)| {
            let header = format!("== {name} ==");
            let budget = share.saturating_sub(header.chars().count() + 2);
            let tail = redact_tail(&text, home, budget);
            (!tail.is_empty()).then(|| format!("{header}\n{tail}"))
        })
        .collect();
    (!sections.is_empty()).then(|| sections.join("\n\n"))
}

/// Read and redact this daemon's recent log. Nothing unredacted leaves here.
pub(crate) async fn read_redacted_daemon_log() -> MachineLogExcerptOutcome {
    let home = dirs::home_dir();
    let config_dir = xmatrix_cli_core::config::config_dir();
    let mut sources: Vec<(String, String)> = log_files(home.as_deref(), &config_dir)
        .into_iter()
        .filter_map(|(name, path)| file_tail(&path).map(|text| (name, text)))
        .collect();
    if let Some(journal) = journal_tail().await {
        sources.push((
            format!("journal {}", xmatrix_cli_update::SYSTEMD_UNIT),
            journal,
        ));
    }
    let home = home
        .map(|home| home.display().to_string())
        .unwrap_or_default();
    match excerpt_of(sources, &home) {
        Some(excerpt) => MachineLogExcerptOutcome {
            status: "succeeded".into(),
            excerpt: Some(excerpt),
            error: None,
        },
        None => MachineLogExcerptOutcome {
            status: "failed".into(),
            excerpt: None,
            error: Some("This machine has no daemon log to share.".into()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_line_leaves_without_home_paths_emails_queries_or_secrets() {
        let home = "/home/ada";
        let line = "\x1b[33m⚠\x1b[0m spawn failed in /home/ada/work/repo for ada@example.com \
            at https://hub.example/api/x?token=abc#frag Authorization: Bearer sk-live-123 \
            password=hunter2 key: \"k1\" /Users/bob/x C:\\Users\\carol\\y \
            id 0123456789abcdef0123456789abcdef01";
        assert_eq!(
            redact_line(line, home),
            "⚠ spawn failed in ~/work/repo for <email> at https://hub.example/api/x?… \
            Authorization: Bearer … password=… key: \"…\" /Users/…/x C:\\Users\\…\\y id …"
        );
    }

    #[test]
    fn short_words_and_plain_paths_are_kept() {
        assert_eq!(
            redact_line(
                "daemon reconnected as laptop (daemon:1) after 3s",
                "/home/ada"
            ),
            "daemon reconnected as laptop (daemon:1) after 3s"
        );
        assert_eq!(redact_line("cwd /opt/xmatrix", ""), "cwd /opt/xmatrix");
    }

    #[test]
    fn a_tail_keeps_the_newest_non_empty_lines_within_its_bound() {
        let text: String = (0..300).map(|n| format!("line {n}\n\n")).collect();
        let tail = redact_tail(&text, "", usize::MAX);
        let lines: Vec<&str> = tail.lines().collect();
        assert_eq!(lines.len(), TAIL_LINES);
        assert_eq!(lines.first(), Some(&"line 100"));
        assert_eq!(lines.last(), Some(&"line 299"));
        let bounded = redact_tail(&text, "", 20);
        assert_eq!(bounded, "line 298\nline 299");
    }

    #[test]
    fn the_excerpt_names_each_source_and_stays_within_the_protocol_bound() {
        let noisy: String = (0..5_000).map(|n| format!("event {n}\n")).collect();
        let excerpt = excerpt_of(
            vec![
                ("daemon.err".into(), noisy.clone()),
                ("daemon.out".into(), "   \n".into()),
                ("journal".into(), noisy),
            ],
            "",
        )
        .expect("excerpt");
        assert!(excerpt.chars().count() <= EXCERPT_MAX_CHARS);
        assert!(excerpt.starts_with("== daemon.err ==\n"));
        assert!(excerpt.contains("\n\n== journal ==\n"));
        assert!(
            !excerpt.contains("daemon.out"),
            "an empty source is left out"
        );
        assert!(excerpt.ends_with("event 4999"));
        assert_eq!(
            excerpt_of(vec![("daemon.err".into(), "\n".into())], ""),
            None
        );
    }

    #[test]
    fn a_file_tail_starts_on_a_whole_line() {
        let root = std::env::temp_dir().join(format!("xmatrix-log-tail-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("daemon.err");
        let long: String = (0..20_000).map(|n| format!("entry {n}\n")).collect();
        std::fs::write(&path, &long).unwrap();
        let tail = file_tail(&path).unwrap();
        assert!(tail.len() as u64 <= TAIL_BYTES);
        assert!(tail.starts_with("entry "));
        assert!(tail.ends_with("entry 19999\n"));
        assert_eq!(file_tail(&root.join("absent")), None);
        std::fs::remove_dir_all(root).unwrap();
    }
}
