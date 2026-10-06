//! Per-run goal command inbox.
//!
//! Claude Code exposes `/goal` only as a command a *user* types; the model has
//! no tool, MCP surface, or SDK call that can set one (unlike Grok's
//! `update_goal` tool or Codex's native `thread/goal/*` RPCs). So an agent
//! running under Claude cannot give itself a goal the way the other runtimes
//! can, even though every part of our observation chain already works.
//!
//! This module closes that gap without a local control port. `xmatrix goal`
//! runs as a short-lived nested process inside the model's own turn, so it
//! cannot be answered synchronously: the wrapper is blocked inside that turn
//! and only reaches its delivery loop once the turn ends. Instead the nested
//! command appends one line to a per-run inbox file whose path the wrapper
//! exports to the runtime child, and the wrapper drains it between turns. Each
//! live instance owns its own file, so concurrent instances on one machine
//! never contend, and the wrapper's loop is the only reader — the ordering is
//! serial by construction.
//!
//! The wrapper publishes the goal it is actually working toward back into a
//! sibling state file so `xmatrix goal status` answers from local state
//! instead of waiting for a turn boundary.

use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use colored::Colorize;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use xmatrix_cli_args::GoalCliCommand;
use xmatrix_cli_core::agent_instance_connection::AgentInstanceConnectionEvent;
use xmatrix_cli_core::error::{CliError, Result};
use xmatrix_cli_core::protocol;

/// Path of this live instance's goal inbox, exported by the wrapper onto the
/// runtime child so every nested `xmatrix` call inherits it.
pub const GOAL_INBOX_ENV: &str = "XMATRIX_AGENT_GOAL_INBOX";

/// Claude Code rejects conditions longer than this, so refuse them at the CLI
/// edge where the operator still sees the error.
pub const GOAL_CONDITION_MAX_CHARS: usize = 4_000;

pub const GOAL_ACTION_SET: &str = "set";
pub const GOAL_ACTION_CLEAR: &str = "clear";

/// One queued goal mutation. Serialized as a single JSON line so concurrent
/// appends from separate `xmatrix goal` processes stay whole.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GoalInboxRecord {
    /// [`GOAL_ACTION_SET`] or [`GOAL_ACTION_CLEAR`].
    pub action: String,
    /// The completion condition; present for `set`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub condition: Option<String>,
    #[serde(default)]
    pub issued_at_millis: u64,
}

impl GoalInboxRecord {
    pub fn set(condition: &str, issued_at_millis: u64) -> Self {
        Self {
            action: GOAL_ACTION_SET.to_string(),
            condition: Some(condition.to_string()),
            issued_at_millis,
        }
    }

    pub fn clear(issued_at_millis: u64) -> Self {
        Self {
            action: GOAL_ACTION_CLEAR.to_string(),
            condition: None,
            issued_at_millis,
        }
    }

    /// The condition to hand a runtime, or `None` for a clear. Returns `None`
    /// for a `set` whose condition is missing or blank so a malformed line can
    /// never be mistaken for a clear.
    pub fn condition_for_set(&self) -> Option<&str> {
        if !self.action.eq_ignore_ascii_case(GOAL_ACTION_SET) {
            return None;
        }
        self.condition
            .as_deref()
            .map(str::trim)
            .filter(|condition| !condition.is_empty())
    }

    pub fn is_clear(&self) -> bool {
        self.action.eq_ignore_ascii_case(GOAL_ACTION_CLEAR)
    }
}

/// The goal the wrapper is actually working toward, published for `status`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct GoalInboxState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub condition: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_reason: Option<String>,
    #[serde(default)]
    pub updated_at_millis: u64,
}

impl GoalInboxState {
    pub fn is_active(&self) -> bool {
        self.condition
            .as_deref()
            .map(str::trim)
            .is_some_and(|condition| !condition.is_empty())
    }
}

/// Inbox path for one live instance, under the same runs directory the daemon
/// already uses for run status markers.
pub fn goal_inbox_path(runs_dir: &Path, instance_id: &str) -> PathBuf {
    runs_dir.join(format!("{}.goal.jsonl", sanitize_id(instance_id)))
}

/// Sibling file holding the published goal state for the same instance.
pub fn goal_state_path(inbox_path: &Path) -> PathBuf {
    let mut path = inbox_path.to_path_buf();
    path.set_extension("state.json");
    path
}

/// Run ids and instance ids carry `:` separators, which are not path-safe on
/// Windows and awkward everywhere else.
fn sanitize_id(id: &str) -> String {
    id.chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect()
}

/// This process's inbox, when it was launched inside a managed agent run.
pub fn goal_inbox_path_from_env() -> Option<PathBuf> {
    std::env::var_os(GOAL_INBOX_ENV)
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
}

/// Appends one queued mutation. `O_APPEND` keeps a single short line whole, so
/// two `xmatrix goal` processes racing inside one turn cannot interleave.
pub fn append_goal_command(path: &Path, record: &GoalInboxRecord) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut line = serde_json::to_string(record)
        .map_err(|err| std::io::Error::new(std::io::ErrorKind::InvalidData, err))?;
    line.push('\n');
    let mut file = private_append_file(path)?;
    file.write_all(line.as_bytes())?;
    file.flush()
}

pub fn write_goal_state(path: &Path, state: &GoalInboxState) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let bytes = serde_json::to_vec_pretty(state)
        .map_err(|err| std::io::Error::new(std::io::ErrorKind::InvalidData, err))?;
    // The reader is a short-lived nested command that tolerates a missing file,
    // so a plain truncating write is enough; no reader keeps an open handle.
    let mut file = private_truncating_file(path)?;
    file.write_all(&bytes)?;
    file.flush()
}

pub fn read_goal_state(path: &Path) -> Option<GoalInboxState> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

#[cfg(unix)]
fn private_append_file(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(path)
}

#[cfg(not(unix))]
fn private_append_file(path: &Path) -> std::io::Result<std::fs::File> {
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
}

#[cfg(unix)]
fn private_truncating_file(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
}

#[cfg(not(unix))]
fn private_truncating_file(path: &Path) -> std::io::Result<std::fs::File> {
    std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(path)
}

/// How often the wrapper looks for a goal the model queued for itself. The
/// command is issued mid-turn and cannot apply before the turn ends anyway, so
/// this only has to be fast relative to a turn.
const GOAL_INBOX_POLL_INTERVAL: Duration = Duration::from_millis(750);

/// The canonical slash command for one queued record, so the wrapper reuses the
/// same `/goal` parsing and per-runtime rewriting that a channel-sent command
/// goes through instead of growing a second goal grammar.
pub fn goal_command_text(record: &GoalInboxRecord) -> Option<String> {
    if let Some(condition) = record.condition_for_set() {
        return Some(format!("/goal {condition}"));
    }
    record.is_clear().then(|| "/goal clear".to_string())
}

/// The inbox this wrapper owns, resolved once so the poller, the runtime child
/// it is exported to, and the published state file can never disagree.
static BOUND_GOAL_INBOX_PATH: OnceLock<Option<PathBuf>> = OnceLock::new();

/// Resolves and remembers this wrapper's inbox path. Returns `None` when the
/// process has no instance id to key one by, in which case `xmatrix goal` stays
/// unavailable rather than writing to a file nobody drains.
pub fn bind_goal_inbox_path(instance_id: Option<&str>) -> Option<PathBuf> {
    BOUND_GOAL_INBOX_PATH
        .get_or_init(|| goal_inbox_path_for_instance(instance_id))
        .clone()
}

/// The already-bound inbox path, for code that runs after [`bind_goal_inbox_path`]
/// (such as spawning the runtime child that must inherit it).
pub fn bound_goal_inbox_path() -> Option<PathBuf> {
    BOUND_GOAL_INBOX_PATH.get().cloned().flatten()
}

/// This live instance's inbox, keyed by instance id so concurrent instances of
/// the same agent on one machine never share a file.
fn goal_inbox_path_for_instance(instance_id: Option<&str>) -> Option<PathBuf> {
    let instance_id = instance_id
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .or_else(|| crate::non_empty_env("XMATRIX_AGENT_INSTANCE_ID"))?;
    Some(goal_inbox_path(
        &xmatrix_cli_core::config::config_dir().join("runs"),
        &instance_id,
    ))
}

/// Watches this instance's inbox and forwards each queued command into the
/// runtime's own event stream.
///
/// Delivering through the event queue (rather than acting on the file inline)
/// is what keeps this serial: the delivery loop already processes one event at
/// a time and parks anything that arrives mid-turn, so a goal the model set
/// during its turn is applied once that turn finishes.
pub fn spawn_goal_inbox_poller(
    path: PathBuf,
    events: mpsc::UnboundedSender<AgentInstanceConnectionEvent>,
) -> tokio::task::JoinHandle<()> {
    // Take the starting offset here, not inside the task: the spawned future
    // does not run until the caller next awaits, and anything appended in that
    // window would be skipped as "already applied".
    let mut watcher = GoalInboxWatcher::new(Some(path));
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(GOAL_INBOX_POLL_INTERVAL).await;
            for record in watcher.poll() {
                let Some(body) = goal_command_text(&record) else {
                    continue;
                };
                if events
                    .send(AgentInstanceConnectionEvent::LocalCommand { body })
                    .is_err()
                {
                    return;
                }
            }
        }
    })
}

/// Publishes the goal this wrapper is working toward so `xmatrix goal status`
/// answers from local state. A run with no bound inbox has no reader either, so
/// this is a no-op there.
pub fn publish_bound_goal_state(goal: Option<&protocol::AgentGoalStatus>) {
    let Some(inbox) = bound_goal_inbox_path() else {
        return;
    };
    let state = GoalInboxState {
        condition: goal.and_then(|goal| goal.objective.clone()),
        status: goal.and_then(|goal| goal.status.clone()),
        last_reason: goal.and_then(|goal| goal.reason.clone()),
        updated_at_millis: unix_millis_now(),
    };
    let _ = write_goal_state(&goal_state_path(&inbox), &state);
}

fn unix_millis_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}

/// The inbox this nested command must write to, or an error naming why this
/// process is not part of a managed agent run.
fn require_goal_inbox() -> Result<PathBuf> {
    goal_inbox_path_from_env().ok_or_else(|| {
        CliError::Launch(
            "`xmatrix goal` only works inside a live agent run started by an xMatrix wrapper \
             (no goal inbox is bound to this shell). A goal belongs to one running instance, \
             so there is nothing to set from an ordinary terminal."
                .to_string(),
        )
    })
}

/// `xmatrix goal set|clear|status`.
///
/// `set` and `clear` are queued rather than applied: the wrapper is blocked
/// inside the very turn that runs this command, and only drains the inbox once
/// that turn ends. Say so in the output so the caller does not read the
/// immediate return as "the goal is already active".
pub fn cmd_goal(command: GoalCliCommand) -> Result<()> {
    match command {
        GoalCliCommand::Set { condition } => {
            let condition = condition.join(" ").trim().to_string();
            if condition.is_empty() {
                return Err(CliError::Launch(
                    "A goal needs a completion condition, e.g. \
                     `xmatrix goal set \"every call site compiles and npm test exits 0\"`."
                        .to_string(),
                ));
            }
            if condition.chars().count() > GOAL_CONDITION_MAX_CHARS {
                return Err(CliError::Launch(format!(
                    "Goal condition is limited to {GOAL_CONDITION_MAX_CHARS} characters (got {}).",
                    condition.chars().count()
                )));
            }
            let path = require_goal_inbox()?;
            append_goal_command(&path, &GoalInboxRecord::set(&condition, unix_millis_now()))?;
            println!("{} Goal queued: {condition}", "✓".green().bold());
            println!(
                "  It becomes this run's active goal at the end of the current turn, and the \
                 runtime then keeps working until the condition holds."
            );
            Ok(())
        }
        GoalCliCommand::Clear => {
            let path = require_goal_inbox()?;
            append_goal_command(&path, &GoalInboxRecord::clear(unix_millis_now()))?;
            println!("{} Goal clear queued", "✓".green().bold());
            println!("  It takes effect at the end of the current turn.");
            Ok(())
        }
        GoalCliCommand::Status { json } => {
            let path = require_goal_inbox()?;
            let state = read_goal_state(&goal_state_path(&path)).unwrap_or_default();
            if json {
                println!("{}", serde_json::to_string_pretty(&state)?);
                return Ok(());
            }
            if !state.is_active() {
                println!("No goal set");
                return Ok(());
            }
            let condition = state.condition.as_deref().unwrap_or_default();
            match state.status.as_deref() {
                Some(status) => println!("Goal ({status}): {condition}"),
                None => println!("Goal: {condition}"),
            }
            if let Some(reason) = state.last_reason.as_deref().map(str::trim)
                && !reason.is_empty()
            {
                println!("Last check: {reason}");
            }
            Ok(())
        }
    }
}

/// Tails one instance's inbox from the wrapper's delivery loop.
///
/// Only whole lines are consumed, so a line still being flushed by a nested
/// `xmatrix goal` is re-read on the next poll instead of being parsed in half.
#[derive(Debug)]
pub struct GoalInboxWatcher {
    path: Option<PathBuf>,
    offset: u64,
}

impl GoalInboxWatcher {
    pub fn new(path: Option<PathBuf>) -> Self {
        // Anything already queued belongs to a previous wrapper generation:
        // start at the current end so a reborn instance does not replay goals
        // its predecessor already applied.
        let offset = path
            .as_ref()
            .and_then(|path| std::fs::metadata(path).ok())
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        Self { path, offset }
    }

    /// Every command queued since the last poll, oldest first.
    pub fn poll(&mut self) -> Vec<GoalInboxRecord> {
        let Some(path) = self.path.as_ref() else {
            return Vec::new();
        };
        let Ok(mut file) = std::fs::File::open(path) else {
            return Vec::new();
        };
        // A truncated inbox (manual cleanup) would otherwise leave the offset
        // past the end and stall every later command.
        if let Ok(metadata) = file.metadata()
            && metadata.len() < self.offset
        {
            self.offset = 0;
        }
        if file.seek(SeekFrom::Start(self.offset)).is_err() {
            return Vec::new();
        }
        let mut appended = String::new();
        if std::io::Read::read_to_string(&mut file, &mut appended).is_err() {
            return Vec::new();
        }
        let Some(end) = appended.rfind('\n') else {
            return Vec::new();
        };
        let consumed = end + 1;
        self.offset += consumed as u64;
        appended[..consumed]
            .lines()
            .filter(|line| !line.trim().is_empty())
            .filter_map(|line| serde_json::from_str::<GoalInboxRecord>(line).ok())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(label: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("xmatrix-goal-inbox-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn watcher_returns_queued_commands_in_order() {
        let dir = temp_dir("order");
        let path = goal_inbox_path(&dir, "instance:summon:abc");
        let mut watcher = GoalInboxWatcher::new(Some(path.clone()));
        assert!(watcher.poll().is_empty());

        append_goal_command(&path, &GoalInboxRecord::set("tests pass", 1)).expect("append set");
        append_goal_command(&path, &GoalInboxRecord::clear(2)).expect("append clear");

        let drained = watcher.poll();
        assert_eq!(drained.len(), 2);
        assert_eq!(drained[0].condition_for_set(), Some("tests pass"));
        assert!(drained[1].is_clear());
        // Draining is not repeatable: the wrapper must not re-apply a goal.
        assert!(watcher.poll().is_empty());
    }

    #[test]
    fn watcher_starts_at_the_end_of_a_preexisting_inbox() {
        let dir = temp_dir("reborn");
        let path = goal_inbox_path(&dir, "instance:summon:def");
        append_goal_command(&path, &GoalInboxRecord::set("stale goal", 1)).expect("append");

        let mut watcher = GoalInboxWatcher::new(Some(path.clone()));
        assert!(watcher.poll().is_empty());

        append_goal_command(&path, &GoalInboxRecord::set("fresh goal", 2)).expect("append");
        let drained = watcher.poll();
        assert_eq!(drained.len(), 1);
        assert_eq!(drained[0].condition_for_set(), Some("fresh goal"));
    }

    #[test]
    fn partially_written_lines_are_re_read_whole() {
        let dir = temp_dir("partial");
        let path = goal_inbox_path(&dir, "instance:summon:ghi");
        let mut watcher = GoalInboxWatcher::new(Some(path.clone()));

        let mut file = private_append_file(&path).expect("open");
        file.write_all(br#"{"action":"set","condition":"half"#)
            .expect("partial write");
        file.flush().expect("flush");
        assert!(watcher.poll().is_empty());

        file.write_all(b"\",\"issued_at_millis\":1}\n")
            .expect("finish write");
        file.flush().expect("flush");
        let drained = watcher.poll();
        assert_eq!(drained.len(), 1);
        assert_eq!(drained[0].condition_for_set(), Some("half"));
    }

    #[test]
    fn a_set_without_a_condition_is_not_a_clear() {
        let record = GoalInboxRecord {
            action: GOAL_ACTION_SET.to_string(),
            condition: Some("   ".to_string()),
            issued_at_millis: 1,
        };
        assert_eq!(record.condition_for_set(), None);
        assert!(!record.is_clear());
    }

    #[test]
    fn state_round_trips_through_the_sibling_file() {
        let dir = temp_dir("state");
        let inbox = goal_inbox_path(&dir, "instance:summon:jkl");
        let state_path = goal_state_path(&inbox);
        assert!(read_goal_state(&state_path).is_none());

        let state = GoalInboxState {
            condition: Some("tests pass".to_string()),
            status: Some("active".to_string()),
            last_reason: Some("two suites still failing".to_string()),
            updated_at_millis: 7,
        };
        write_goal_state(&state_path, &state).expect("write state");
        assert_eq!(read_goal_state(&state_path), Some(state));
    }

    #[tokio::test]
    async fn poller_forwards_a_command_queued_after_it_started() {
        let dir = std::env::temp_dir().join(format!("xmatrix-goal-poller-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = goal_inbox_path(&dir, "instance:poller:1");
        let (tx, mut rx) = mpsc::unbounded_channel();
        let handle = spawn_goal_inbox_poller(path.clone(), tx);
        append_goal_command(&path, &GoalInboxRecord::set("tests pass", 1)).expect("append");
        let event = tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("poller forwards within five seconds")
            .expect("sender alive");
        let AgentInstanceConnectionEvent::LocalCommand { body } = event else {
            panic!("expected a local command");
        };
        assert_eq!(body, "/goal tests pass");
        handle.abort();
    }
}
