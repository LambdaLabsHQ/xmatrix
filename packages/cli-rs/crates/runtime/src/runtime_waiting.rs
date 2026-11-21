// What an Instance with work in hand waits on while its model produces nothing
// (docs/design/agent-status.md). A runtime feeds in the tool calls it sees open
// and close; the wait it reports is the oldest call still open past the
// threshold. It says what the harness itself says about the call, unchanged:
// the description the model gave it, else the command, URL, query or tool
// name; and between turns the descriptions of the background tasks.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, UNIX_EPOCH};

use serde_json::Value;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use crate::protocol;

/// A tool call that has not returned after this long is a wait, not work.
pub(crate) const TOOL_WAIT_THRESHOLD: Duration = Duration::from_secs(15);

/// The longest label carried, in characters.
const LABEL_MAX_CHARS: usize = 160;
/// The longest detail (a command line, a task's description), in characters.
const DETAIL_MAX_CHARS: usize = 300;
/// The most details carried.
const DETAILS_MAX: usize = 4;

/// What one tool call waits on, as the harness put it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ToolWait {
    /// The call's description, or the command, URL, query or tool name.
    pub(crate) label: String,
    /// The command line, when the label is its description.
    pub(crate) details: Vec<String>,
}

struct OpenTool {
    wait: ToolWait,
    opened: Instant,
    opened_millis: u64,
}

/// The tool calls open in the current turn.
pub(crate) struct ToolWaits {
    open: HashMap<String, OpenTool>,
    threshold: Duration,
}

impl Default for ToolWaits {
    fn default() -> Self {
        Self::new(TOOL_WAIT_THRESHOLD)
    }
}

impl ToolWaits {
    pub fn new(threshold: Duration) -> Self {
        Self {
            open: HashMap::new(),
            threshold,
        }
    }

    /// A call opened; a repeated id keeps its first open time.
    pub(crate) fn open(&mut self, id: String, wait: ToolWait, now: Instant, now_millis: u64) {
        self.open.entry(id).or_insert(OpenTool {
            wait,
            opened: now,
            opened_millis: now_millis,
        });
    }

    /// Update an open call's wait description while keeping its original open
    /// time, or open it if it was not yet tracked.
    pub(crate) fn update(&mut self, id: String, wait: ToolWait, now: Instant, now_millis: u64) {
        self.open
            .entry(id)
            .and_modify(|entry| entry.wait = wait.clone())
            .or_insert(OpenTool {
                wait,
                opened: now,
                opened_millis: now_millis,
            });
    }

    pub(crate) fn close(&mut self, id: &str) {
        self.open.remove(id);
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.open.is_empty()
    }

    /// Drain still-open calls ordered oldest-first (used when a turn ends with
    /// background tasks still in progress).
    pub(crate) fn drain_open(&mut self) -> Vec<(String, ToolWait, u64)> {
        let mut entries: Vec<_> = self.open.drain().collect();
        entries.sort_by(|(id_a, a), (id_b, b)| a.opened.cmp(&b.opened).then_with(|| id_a.cmp(id_b)));
        entries
            .into_iter()
            .map(|(id, tool)| (id, tool.wait, tool.opened_millis))
            .collect()
    }

    /// The turn ended: whatever it left open is no longer waited on.
    pub(crate) fn clear(&mut self) {
        self.open.clear();
    }

    fn oldest(&self) -> Option<&OpenTool> {
        self.open.values().min_by_key(|tool| tool.opened)
    }

    /// When the oldest open call becomes a wait, while that is still ahead.
    pub(crate) fn deadline(&self, now: Instant) -> Option<Instant> {
        let deadline = self.oldest()?.opened + self.threshold;
        (deadline > now).then_some(deadline)
    }

    /// The wait at `now`: the oldest call open past the threshold.
    pub(crate) fn waiting(&self, now: Instant) -> Option<protocol::AgentRuntimeWaiting> {
        let tool = self
            .oldest()
            .filter(|tool| now.saturating_duration_since(tool.opened) >= self.threshold)?;
        Some(protocol::AgentRuntimeWaiting {
            kind: "tool".into(),
            count: None,
            label: Some(tool.wait.label.clone()),
            details: tool.wait.details.clone(),
            since_millis: tool.opened_millis,
        })
    }
}

/// Background tasks still running after their turn ended, with the
/// descriptions they were started with.
pub(crate) fn background_wait(
    count: u32,
    descriptions: &[&str],
    since_millis: u64,
) -> Option<protocol::AgentRuntimeWaiting> {
    (count > 0).then(|| protocol::AgentRuntimeWaiting {
        kind: "background".into(),
        // The fact; clients word it ("2 tasks").
        label: None,
        count: Some(count),
        details: descriptions
            .iter()
            .filter_map(|description| one_line(description, DETAIL_MAX_CHARS))
            .take(DETAILS_MAX)
            .collect(),
        since_millis,
    })
}

/// Text as it is shown: one line, trimmed, at most `max` characters; `None`
/// when nothing is left.
fn one_line(text: &str, max: usize) -> Option<String> {
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.is_empty() {
        return None;
    }
    if line.chars().count() <= max {
        return Some(line);
    }
    let cut: String = line.chars().take(max - 1).collect();
    Some(format!("{}…", cut.trim_end()))
}

/// The wait for a call: its description with the command under it, else the
/// first of `fallbacks` that says anything, else `name`.
fn tool_wait(
    description: Option<&str>,
    command: Option<&str>,
    fallbacks: &[Option<&str>],
    name: &str,
) -> ToolWait {
    let command_line = command.and_then(|command| one_line(command, DETAIL_MAX_CHARS));
    if let Some(label) = description.and_then(|description| one_line(description, LABEL_MAX_CHARS))
    {
        return ToolWait {
            label,
            details: command_line.into_iter().collect(),
        };
    }
    if let Some(label) = command.and_then(|command| one_line(command, LABEL_MAX_CHARS)) {
        // A command longer than a label keeps more of itself under it.
        let details = command_line
            .filter(|line| *line != label)
            .into_iter()
            .collect();
        return ToolWait { label, details };
    }
    let label = fallbacks
        .iter()
        .find_map(|text| text.and_then(|text| one_line(text, LABEL_MAX_CHARS)))
        .or_else(|| one_line(name, LABEL_MAX_CHARS))
        .unwrap_or_else(|| "a tool".into());
    ToolWait {
        label,
        details: Vec::new(),
    }
}

/// The wait for a Claude Code tool call, or `None` for a call that is never a
/// wait: a subagent (`Task`, `Agent`) is working, not waiting.
pub(crate) fn claude_tool_wait(tool: &str, input: &Value) -> Option<ToolWait> {
    if matches!(tool, "Task" | "Agent") {
        return None;
    }
    let text = |pointer: &str| input.pointer(pointer).and_then(Value::as_str);
    Some(tool_wait(
        text("/description"),
        text("/command"),
        &[text("/url"), text("/query"), text("/questions/0/question")],
        tool,
    ))
}

/// The wait for a Codex app-server thread item, or `None` for an item that is
/// never a wait: messages, reasoning, file edits, and subagent calls.
pub(crate) fn codex_item_wait(item: &Value) -> Option<ToolWait> {
    let kind = item.get("type").and_then(Value::as_str)?;
    let text = |key: &str| item.get(key).and_then(Value::as_str);
    match kind {
        "commandExecution" => {
            let command = crate::runtime_channel_activity::codex_command_text(item);
            Some(tool_wait(None, command.as_deref(), &[], kind))
        }
        "webSearch" => Some(tool_wait(None, None, &[text("query")], kind)),
        "mcpToolCall" | "dynamicToolCall" => {
            let name = [text("server"), text("tool")]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(" ");
            Some(tool_wait(None, None, &[Some(name.as_str())], kind))
        }
        _ => None,
    }
}

/// Whether an ACP `tool_call` / `tool_call_update` status marks the call ended.
pub(crate) fn acp_tool_is_terminal(status: Option<&str>) -> bool {
    matches!(status, Some("completed" | "failed" | "cancelled"))
}

/// Whether an ACP tool call explicitly started a long-lived daemon process or
/// standing cron (`IsDaemon: true`), which the agent is not waiting on to end.
pub(crate) fn acp_tool_is_daemon(update: &Value) -> bool {
    let input = update.get("rawInput").or_else(|| update.get("args"));
    input.is_some_and(|input| {
        input.get("IsDaemon").and_then(Value::as_bool) == Some(true)
            || input.get("isDaemon").and_then(Value::as_bool) == Some(true)
    })
}

/// Whether an ACP `tool_call_update` carries tool metadata rather than only a
/// status change.
pub(crate) fn acp_tool_has_wait_metadata(update: &Value) -> bool {
    update.get("rawInput").is_some()
        || update.get("args").is_some()
        || update
            .get("title")
            .and_then(Value::as_str)
            .is_some_and(|text| !text.trim().is_empty())
        || update
            .get("name")
            .and_then(Value::as_str)
            .is_some_and(|text| !text.trim().is_empty())
}

fn acp_command_text(input: &Value) -> Option<String> {
    for key in ["CommandLine", "command", "cmd"] {
        match input.get(key) {
            Some(Value::String(command)) if !command.trim().is_empty() => {
                return Some(command.clone());
            }
            Some(Value::Array(words)) => {
                let joined = words
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(" ");
                if !joined.trim().is_empty() {
                    return Some(joined);
                }
            }
            _ => {}
        }
    }
    None
}

/// The wait for an ACP `tool_call` / `tool_call_update` payload, or `None` for
/// a subagent call (a subagent is working, not waiting).
pub(crate) fn acp_tool_wait(update: &Value) -> Option<ToolWait> {
    let name = update.get("name").and_then(Value::as_str);
    if matches!(name, Some("Task" | "Agent" | "invoke_subagent")) {
        return None;
    }
    let title = update.get("title").and_then(Value::as_str);
    let input = update.get("rawInput").or_else(|| update.get("args"));
    let text = |pointer: &str| {
        input
            .and_then(|value| value.pointer(pointer))
            .and_then(Value::as_str)
    };
    let description = text("/toolSummary")
        .or_else(|| text("/description"))
        .or_else(|| text("/Description"));
    let command = input.and_then(acp_command_text);
    let fallback_name = name.or(title).unwrap_or("tool");
    Some(tool_wait(
        description,
        command.as_deref(),
        &[
            text("/url"),
            text("/query"),
            text("/Prompt"),
            text("/questions/0/question"),
            title,
        ],
        fallback_name,
    ))
}

#[derive(Debug, Clone)]
struct AcpBackgroundTask {
    description: String,
    opened_millis: u64,
}

/// Background tasks that outlived an ACP turn (for example Antigravity
/// background `run_command`, `schedule`, and `run_workflow` tool calls left
/// `in_progress` when `session/prompt` returned `end_turn`).
#[derive(Debug, Default)]
pub(crate) struct AcpBackgroundTasks {
    running: HashMap<String, AcpBackgroundTask>,
    since_millis: Option<u64>,
}

impl AcpBackgroundTasks {
    pub(crate) fn insert(&mut self, id: String, description: String, opened_millis: u64) {
        self.running.entry(id).or_insert(AcpBackgroundTask {
            description,
            opened_millis,
        });
        self.since_millis = Some(match self.since_millis {
            Some(existing) => existing.min(opened_millis),
            None => opened_millis,
        });
    }

    pub(crate) fn remove(&mut self, id: &str) -> bool {
        let removed = self.running.remove(id).is_some();
        if self.running.is_empty() {
            self.since_millis = None;
        }
        removed
    }

    pub(crate) fn clear(&mut self) {
        self.running.clear();
        self.since_millis = None;
    }

    pub(crate) fn count(&self) -> u32 {
        self.running.len() as u32
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.running.is_empty()
    }

    pub(crate) fn waiting(&self) -> Option<protocol::AgentRuntimeWaiting> {
        let since_millis = self.since_millis?;
        let mut entries: Vec<_> = self.running.iter().collect();
        entries.sort_by(|(id_a, a), (id_b, b)| {
            a.opened_millis
                .cmp(&b.opened_millis)
                .then_with(|| id_a.cmp(id_b))
        });
        let descriptions: Vec<&str> = entries
            .iter()
            .map(|(_, task)| task.description.as_str())
            .collect();
        background_wait(self.count(), &descriptions, since_millis)
    }
}

/// Snapshot of direct Antigravity (`agy`) subagent activity for one ACP
/// session, read from `<app_data_dir>/brain/<session_id>/.system_generated/`.
///
/// Antigravity's ACP v1 server marks `invoke_subagent` `completed` as soon as
/// the subagent conversation is spawned and emits no ACP events while the
/// subagent runs. Its on-disk `.system_generated/subagents/*.json` and
/// parent/child `.system_generated/messages/*.json` files record the live
/// assignment/report state without touching `agy`'s shared SQLite summary DB.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct AntigravitySubagentState {
    /// Count of `SUBAGENT_STATE_ALIVE` subagents whose latest assignment from
    /// this session has not yet produced a read report back to the parent.
    pub(crate) active_count: u32,
    /// Number of report messages from alive subagents already marked read in
    /// the parent's `.system_generated/messages/read.json` (distinguishes a
    /// completed subagent about to wake the parent from a killed subagent).
    pub(crate) read_report_count: usize,
}

/// Resolve Antigravity's local brain directory (`$ANTIGRAVITY_APP_DATA_DIR/brain`
/// or `~/.gemini/antigravity-cli/brain`).
pub(crate) fn antigravity_brain_dir() -> Option<PathBuf> {
    if let Ok(app_data_dir) = std::env::var("ANTIGRAVITY_APP_DATA_DIR") {
        let trimmed = app_data_dir.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed).join("brain"));
        }
    }
    Some(
        dirs::home_dir()?
            .join(".gemini")
            .join("antigravity-cli")
            .join("brain"),
    )
}

pub(crate) fn read_antigravity_subagent_state(
    brain_dir: &Path,
    session_id: &str,
) -> AntigravitySubagentState {
    if session_id.trim().is_empty() {
        return AntigravitySubagentState::default();
    }
    let parent_sys = brain_dir.join(session_id).join(".system_generated");
    let alive_ids = read_alive_subagent_ids(&parent_sys.join("subagents"));
    if alive_ids.is_empty() {
        return AntigravitySubagentState::default();
    }
    let alive_set: HashSet<&str> = alive_ids.iter().map(String::as_str).collect();
    let (latest_reports, read_report_count) =
        read_parent_subagent_reports(&parent_sys.join("messages"), &alive_set);

    let mut active_count: u32 = 0;
    for child_id in &alive_ids {
        let child_messages = brain_dir
            .join(child_id)
            .join(".system_generated")
            .join("messages");
        if dir_has_any_entry(&child_messages.join("undelivered")) {
            active_count = active_count.saturating_add(1);
            continue;
        }
        let Some(assigned_nanos) = read_latest_assignment_nanos(&child_messages, session_id) else {
            continue;
        };
        let still_active = match latest_reports.get(child_id.as_str()) {
            None => true,
            Some(&(reported_nanos, is_read)) => reported_nanos < assigned_nanos || !is_read,
        };
        if still_active {
            active_count = active_count.saturating_add(1);
        }
    }

    AntigravitySubagentState {
        active_count,
        read_report_count,
    }
}

fn for_each_json_in_dir(
    dir: &Path,
    skip_read_json: bool,
    mut visit: impl FnMut(&Path, Value),
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json")
            || (skip_read_json
                && path.file_name().and_then(|name| name.to_str()) == Some("read.json"))
            || !path.is_file()
        {
            continue;
        }
        let Ok(raw) = std::fs::read_to_string(&path) else {
            continue;
        };
        if let Ok(value) = serde_json::from_str::<Value>(&raw) {
            visit(&path, value);
        }
    }
}

fn read_alive_subagent_ids(subagents_dir: &Path) -> Vec<String> {
    let mut ids = Vec::new();
    for_each_json_in_dir(subagents_dir, false, |_, value| {
        if value.get("state").and_then(Value::as_str) != Some("SUBAGENT_STATE_ALIVE") {
            return;
        }
        if let Some(id) = value
            .get("conversationId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty())
        {
            ids.push(id.to_string());
        }
    });
    ids
}

fn read_parent_subagent_reports<'a>(
    messages_dir: &Path,
    alive_ids: &HashSet<&'a str>,
) -> (HashMap<&'a str, (i128, bool)>, usize) {
    let read_ids = read_message_read_set(&messages_dir.join("read.json"));
    let mut latest: HashMap<&'a str, (i128, bool)> = HashMap::new();
    let mut report_count: usize = 0;
    for_each_json_in_dir(messages_dir, true, |path, value| {
        let Some(sender) = value.get("sender").and_then(Value::as_str) else {
            return;
        };
        let matched_child = if let Some(&child_id) = alive_ids.get(sender) {
            Some(child_id)
        } else if sender == "system" {
            let content = value
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or_default();
            alive_ids
                .iter()
                .copied()
                .find(|child_id| content.contains(*child_id))
        } else {
            None
        };
        let Some(child_id) = matched_child else {
            return;
        };
        let ts_nanos = message_timestamp_nanos(&value, path);
        let is_read = value
            .get("id")
            .and_then(Value::as_str)
            .is_some_and(|id| read_ids.contains(id));
        if is_read {
            report_count += 1;
        }
        latest
            .entry(child_id)
            .and_modify(|existing| {
                if ts_nanos > existing.0 || (ts_nanos == existing.0 && !is_read) {
                    *existing = (ts_nanos, is_read);
                }
            })
            .or_insert((ts_nanos, is_read));
    });
    (latest, report_count)
}

fn read_latest_assignment_nanos(child_messages_dir: &Path, parent_id: &str) -> Option<i128> {
    let mut latest: Option<i128> = None;
    for_each_json_in_dir(child_messages_dir, true, |path, value| {
        if value.get("sender").and_then(Value::as_str) != Some(parent_id) {
            return;
        }
        let ts_nanos = message_timestamp_nanos(&value, path);
        latest = Some(match latest {
            Some(existing) => existing.max(ts_nanos),
            None => ts_nanos,
        });
    });
    latest
}

fn read_message_read_set(path: &Path) -> HashSet<String> {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return HashSet::new();
    };
    let Ok(Value::Object(map)) = serde_json::from_str::<Value>(&raw) else {
        return HashSet::new();
    };
    map.into_iter()
        .filter_map(|(key, val)| (val.as_bool() == Some(true)).then_some(key))
        .collect()
}

fn dir_has_any_entry(dir: &Path) -> bool {
    std::fs::read_dir(dir)
        .ok()
        .and_then(|mut entries| entries.next())
        .is_some()
}

fn message_timestamp_nanos(value: &Value, path: &Path) -> i128 {
    if let Some(raw) = value.get("timestamp").and_then(Value::as_str)
        && let Ok(parsed) = OffsetDateTime::parse(raw.trim(), &Rfc3339)
    {
        return parsed.unix_timestamp_nanos();
    }
    std::fs::metadata(path)
        .ok()
        .and_then(|meta| meta.modified().ok())
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos() as i128)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn wait(label: &str) -> ToolWait {
        ToolWait {
            label: label.into(),
            details: Vec::new(),
        }
    }

    #[test]
    fn a_call_becomes_a_wait_only_past_the_threshold() {
        let start = Instant::now();
        let mut waits = ToolWaits::default();
        assert_eq!(waits.deadline(start), None);
        let ci = ToolWait {
            label: "Wait for CI on PR #7".into(),
            details: vec!["gh pr checks 7 --watch".into()],
        };
        waits.open("t1".into(), ci, start, 1_000);
        assert_eq!(waits.deadline(start), Some(start + TOOL_WAIT_THRESHOLD));
        assert_eq!(waits.waiting(start + Duration::from_secs(14)), None);
        let waiting = waits.waiting(start + TOOL_WAIT_THRESHOLD).expect("a wait");
        assert_eq!(waiting.kind, "tool");
        assert_eq!(waiting.label.as_deref(), Some("Wait for CI on PR #7"));
        assert_eq!(waiting.details, vec!["gh pr checks 7 --watch".to_string()]);
        assert_eq!(waiting.since_millis, 1_000);
        // Past the threshold nothing is left to schedule.
        assert_eq!(waits.deadline(start + TOOL_WAIT_THRESHOLD), None);
        waits.close("t1");
        assert_eq!(waits.waiting(start + Duration::from_secs(60)), None);
    }

    #[test]
    fn the_oldest_open_call_names_the_wait_and_a_turn_end_clears_it() {
        let start = Instant::now();
        let mut waits = ToolWaits::default();
        waits.open("old".into(), wait("cargo build"), start, 1);
        waits.open(
            "new".into(),
            wait("git push"),
            start + Duration::from_secs(10),
            2,
        );
        // A repeated id keeps its first open time.
        waits.open(
            "old".into(),
            wait("cargo test"),
            start + Duration::from_secs(12),
            3,
        );
        let at = start + Duration::from_secs(20);
        assert_eq!(
            waits.waiting(at).and_then(|w| w.label).as_deref(),
            Some("cargo build")
        );
        waits.close("old");
        assert_eq!(waits.waiting(at), None);
        assert_eq!(waits.deadline(at), Some(start + Duration::from_secs(25)));
        waits.clear();
        assert_eq!(waits.waiting(start + Duration::from_secs(60)), None);
    }

    #[test]
    fn a_turn_end_clears_a_tool_wait_but_not_background_tasks() {
        let tracker = crate::AgentRuntimeStateTracker::new("test");
        let turn = tracker.begin_turn(Some("channel-1"), None);
        let ci = protocol::AgentRuntimeWaiting {
            count: None,
            kind: "tool".into(),
            label: Some("gh pr checks 1 --watch".into()),
            details: Vec::new(),
            since_millis: 5,
        };
        assert!(tracker.set_waiting(Some(ci.clone())));
        assert!(
            !tracker.set_waiting(Some(ci)),
            "an unchanged wait is not reported again"
        );
        assert_eq!(
            tracker.snapshot().waiting.map(|w| w.kind).as_deref(),
            Some("tool")
        );
        drop(turn);
        assert!(
            tracker.waiting_snapshot().is_none(),
            "a tool call cannot outlive its turn"
        );

        let turn = tracker.begin_turn(Some("channel-1"), None);
        assert!(tracker.set_waiting(background_wait(2, &[], 7)));
        drop(turn);
        let between = tracker
            .waiting_snapshot()
            .expect("background tasks outlive the turn");
        assert_eq!(between.status, "idle");
        assert_eq!(between.waiting.and_then(|w| w.count), Some(2));
    }

    #[test]
    fn background_tasks_are_a_wait_with_their_count_and_descriptions() {
        assert_eq!(background_wait(0, &[], 5), None);
        let one = background_wait(1, &["Watch CI\n for  PR #3781"], 5).expect("a wait");
        assert_eq!(
            (
                one.kind.as_str(),
                one.count,
                one.label.as_deref(),
                one.since_millis
            ),
            ("background", Some(1), None, 5)
        );
        assert_eq!(one.details, vec!["Watch CI for PR #3781"]);
        let many = background_wait(6, &["", "a", "b", "c", "d", "e"], 5).expect("a wait");
        assert_eq!(many.count, Some(6));
        assert_eq!(many.details, vec!["a", "b", "c", "d"]);
    }

    #[test]
    fn a_wait_says_what_the_harness_says_about_the_call() {
        // A description leads, with the command under it.
        assert_eq!(
            claude_tool_wait(
                "Bash",
                &json!({ "command": "gh pr checks 3591 --watch", "description": " Wait for CI " })
            ),
            Some(ToolWait {
                label: "Wait for CI".into(),
                details: vec!["gh pr checks 3591 --watch".into()],
            })
        );
        // Without one, the command itself.
        assert_eq!(
            claude_tool_wait(
                "Bash",
                &json!({ "command": "cargo test -p xmatrix-cli-runtime" })
            ),
            Some(wait("cargo test -p xmatrix-cli-runtime"))
        );
        assert_eq!(
            claude_tool_wait(
                "WebFetch",
                &json!({ "url": "https://x.test/a", "prompt": "p" })
            ),
            Some(wait("https://x.test/a"))
        );
        assert_eq!(
            claude_tool_wait("WebSearch", &json!({ "query": "rust select" })),
            Some(wait("rust select"))
        );
        assert_eq!(
            claude_tool_wait(
                "AskUserQuestion",
                &json!({ "questions": [{ "question": "Merge now?" }] })
            ),
            Some(wait("Merge now?"))
        );
        assert_eq!(
            claude_tool_wait("mcp__server__tool", &json!({})),
            Some(wait("mcp__server__tool"))
        );
        assert_eq!(claude_tool_wait("Task", &json!({})), None);
        assert_eq!(claude_tool_wait("Agent", &json!({})), None);
        let long =
            claude_tool_wait("Bash", &json!({ "command": "x".repeat(400) })).expect("a wait");
        assert_eq!(long.label.chars().count(), LABEL_MAX_CHARS);
        assert!(long.label.ends_with('…'));
        assert_eq!(long.details[0].chars().count(), DETAIL_MAX_CHARS);

        assert_eq!(
            codex_item_wait(
                &json!({ "type": "commandExecution", "command": ["gh", "run", "watch", "7"] })
            ),
            Some(wait("gh run watch 7"))
        );
        assert_eq!(
            codex_item_wait(&json!({ "type": "webSearch", "query": "q" })),
            Some(wait("q"))
        );
        assert_eq!(
            codex_item_wait(
                &json!({ "type": "mcpToolCall", "server": "github", "tool": "get_pr" })
            ),
            Some(wait("github get_pr"))
        );
        for never in [
            "agentMessage",
            "reasoning",
            "fileChange",
            "collabAgentToolCall",
        ] {
            assert_eq!(codex_item_wait(&json!({ "type": never })), None, "{never}");
        }
    }

    #[test]
    fn acp_tool_waits_extract_antigravity_and_generic_fields_and_skip_subagents() {
        assert_eq!(
            acp_tool_wait(&json!({
                "name": "run_command",
                "title": "gh pr checks 7 --watch",
                "rawInput": {
                    "CommandLine": "gh pr checks 7 --watch",
                    "toolSummary": "Wait for CI"
                }
            })),
            Some(ToolWait {
                label: "Wait for CI".into(),
                details: vec!["gh pr checks 7 --watch".into()],
            })
        );
        assert_eq!(
            acp_tool_wait(&json!({
                "name": "schedule",
                "title": "Run schedule",
                "rawInput": {
                    "DurationSeconds": 300,
                    "Prompt": "Check PR #1816 CI"
                }
            })),
            Some(wait("Check PR #1816 CI"))
        );
        assert_eq!(
            acp_tool_wait(&json!({
                "name": "run_workflow",
                "title": "Run workflow",
                "rawInput": { "Description": "Audit all routes" }
            })),
            Some(wait("Audit all routes"))
        );
        assert_eq!(
            acp_tool_wait(&json!({
                "title": "bash",
                "rawInput": { "command": "pnpm test" }
            })),
            Some(wait("pnpm test"))
        );
        assert_eq!(
            acp_tool_wait(&json!({
                "title": "Read repository files"
            })),
            Some(wait("Read repository files"))
        );
        for subagent in ["invoke_subagent", "Task", "Agent"] {
            assert_eq!(
                acp_tool_wait(&json!({ "name": subagent, "title": "Run subagent" })),
                None,
                "{subagent}"
            );
        }
        assert!(acp_tool_is_daemon(&json!({
            "name": "run_command",
            "rawInput": { "CommandLine": "pnpm dev", "IsDaemon": true }
        })));
        assert!(!acp_tool_is_daemon(&json!({
            "name": "run_command",
            "rawInput": { "CommandLine": "sleep 60", "IsDaemon": false }
        })));
        assert!(acp_tool_is_terminal(Some("completed")));
        assert!(acp_tool_is_terminal(Some("failed")));
        assert!(acp_tool_is_terminal(Some("cancelled")));
        assert!(!acp_tool_is_terminal(Some("in_progress")));
        assert!(!acp_tool_is_terminal(Some("pending")));
        assert!(!acp_tool_is_terminal(None));
    }

    #[test]
    fn tool_waits_update_preserves_open_time_and_acp_background_tasks_report_sorted_details() {
        let start = Instant::now();
        let mut waits = ToolWaits::default();
        waits.open("c1".into(), wait("bash"), start, 100);
        waits.update(
            "c1".into(),
            wait("cargo test -p xmatrix-cli-runtime"),
            start + Duration::from_secs(10),
            200,
        );
        waits.open(
            "c2".into(),
            wait("Check PR CI"),
            start + Duration::from_secs(5),
            150,
        );
        let at = start + TOOL_WAIT_THRESHOLD;
        let waiting = waits.waiting(at).expect("original open time preserved");
        assert_eq!(
            waiting.label.as_deref(),
            Some("cargo test -p xmatrix-cli-runtime")
        );
        assert_eq!(waiting.since_millis, 100);

        let drained = waits.drain_open();
        assert_eq!(drained.len(), 2);
        assert_eq!(drained[0].0, "c1");
        assert_eq!(drained[1].0, "c2");
        assert!(waits.is_empty());

        let mut bg = AcpBackgroundTasks::default();
        assert_eq!(bg.waiting(), None);
        for (id, wait, opened_millis) in drained {
            bg.insert(id, wait.label, opened_millis);
        }
        let bg_wait = bg.waiting().expect("background wait");
        assert_eq!(bg_wait.kind, "background");
        assert_eq!(bg_wait.count, Some(2));
        assert_eq!(bg_wait.since_millis, 100);
        assert_eq!(
            bg_wait.details,
            vec![
                "cargo test -p xmatrix-cli-runtime".to_string(),
                "Check PR CI".to_string()
            ]
        );
        assert!(bg.remove("c1"));
        assert_eq!(bg.count(), 1);
        assert!(bg.remove("c2"));
        assert_eq!(bg.waiting(), None);
    }

    #[test]
    fn antigravity_subagent_state_tracks_active_read_followup_and_killed_children() {
        let root = std::env::temp_dir().join(format!(
            "xmatrix-agy-subagent-test-{}",
            uuid::Uuid::new_v4()
        ));
        let brain = root.join("brain");
        let parent = "parent-session";
        let child_a = "child-a";
        let child_b = "child-b";
        let write_json = |path: PathBuf, body: Value| {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, serde_json::to_string(&body).unwrap()).unwrap();
        };

        assert_eq!(
            read_antigravity_subagent_state(&brain, parent),
            AntigravitySubagentState::default()
        );

        // Spawn two alive subagents with initial assignments from parent.
        for child in [child_a, child_b] {
            write_json(
                brain.join(parent).join(".system_generated/subagents").join(format!("{child}.json")),
                json!({
                    "conversationId": child,
                    "subagentDescriptor": { "typeName": "self", "role": "Worker" },
                    "state": "SUBAGENT_STATE_ALIVE"
                }),
            );
            write_json(
                brain.join(child).join(".system_generated/messages/assign-1.json"),
                json!({
                    "id": "assign-1",
                    "sender": parent,
                    "recipient": child,
                    "timestamp": "2026-11-20T09:10:00Z"
                }),
            );
        }
        assert_eq!(
            read_antigravity_subagent_state(&brain, parent),
            AntigravitySubagentState {
                active_count: 2,
                read_report_count: 0,
            }
        );

        // Child A reports back via send_message, not yet read by parent -> still active.
        write_json(
            brain.join(parent).join(".system_generated/messages/rep-a1.json"),
            json!({
                "id": "rep-a1",
                "sender": child_a,
                "recipient": parent,
                "timestamp": "2026-11-20T09:10:05Z",
                "content": "done"
            }),
        );
        assert_eq!(
            read_antigravity_subagent_state(&brain, parent),
            AntigravitySubagentState {
                active_count: 2,
                read_report_count: 0,
            }
        );

        // Once parent reads rep-a1, only Child B remains active.
        write_json(
            brain.join(parent).join(".system_generated/messages/read.json"),
            json!({ "rep-a1": true }),
        );
        assert_eq!(
            read_antigravity_subagent_state(&brain, parent),
            AntigravitySubagentState {
                active_count: 1,
                read_report_count: 1,
            }
        );

        // Child B finishes without send_message -> system idle report, marked read.
        write_json(
            brain.join(parent).join(".system_generated/messages/rep-b1.json"),
            json!({
                "id": "rep-b1",
                "sender": "system",
                "recipient": parent,
                "timestamp": "2026-11-20T09:10:10Z",
                "content": format!("Subagent {child_b} has gone idle.")
            }),
        );
        write_json(
            brain.join(parent).join(".system_generated/messages/read.json"),
            json!({ "rep-a1": true, "rep-b1": true }),
        );
        assert_eq!(
            read_antigravity_subagent_state(&brain, parent),
            AntigravitySubagentState {
                active_count: 0,
                read_report_count: 2,
            }
        );

        // A follow-up assignment to Child A reactivates it.
        write_json(
            brain.join(child_a).join(".system_generated/messages/assign-2.json"),
            json!({
                "id": "assign-2",
                "sender": parent,
                "recipient": child_a,
                "timestamp": "2026-11-20T09:10:20Z"
            }),
        );
        assert_eq!(
            read_antigravity_subagent_state(&brain, parent).active_count,
            1
        );

        // Killing Child A clears it without bumping read_report_count.
        write_json(
            brain.join(parent).join(".system_generated/subagents").join(format!("{child_a}.json")),
            json!({
                "conversationId": child_a,
                "state": "SUBAGENT_STATE_KILLED"
            }),
        );
        assert_eq!(
            read_antigravity_subagent_state(&brain, parent),
            AntigravitySubagentState {
                active_count: 0,
                read_report_count: 1,
            }
        );

        // An undelivered message to Child B also counts as active.
        write_json(
            brain.join(child_b).join(".system_generated/messages/undelivered/u1.json"),
            json!({ "id": "u1" }),
        );
        assert_eq!(
            read_antigravity_subagent_state(&brain, parent).active_count,
            1
        );

        let _ = std::fs::remove_dir_all(&root);
    }
}
