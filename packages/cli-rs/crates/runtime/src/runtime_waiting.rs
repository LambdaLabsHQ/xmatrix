// What an Instance with work in hand waits on while its model produces nothing
// (docs/design/agent-status.md). A runtime feeds in the tool calls it sees open
// and close; the wait it reports is the oldest call still open past the
// threshold. It says what the harness itself says about the call, unchanged:
// the description the model gave it, else the command, URL, query or tool
// name; and between turns the descriptions of the background tasks.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use serde_json::Value;

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
    pub(crate) fn new(threshold: Duration) -> Self {
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

    pub(crate) fn close(&mut self, id: &str) {
        self.open.remove(id);
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
        label: Some(if count == 1 {
            "1 task".into()
        } else {
            format!("{count} tasks")
        }),
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
        assert_eq!(
            between.waiting.and_then(|w| w.label).as_deref(),
            Some("2 tasks")
        );
    }

    #[test]
    fn background_tasks_are_a_wait_with_their_count_and_descriptions() {
        assert_eq!(background_wait(0, &[], 5), None);
        let one = background_wait(1, &["Watch CI\n for  PR #3781"], 5).expect("a wait");
        assert_eq!(
            (one.kind.as_str(), one.label.as_deref(), one.since_millis),
            ("background", Some("1 task"), 5)
        );
        assert_eq!(one.details, vec!["Watch CI for PR #3781"]);
        let many = background_wait(6, &["", "a", "b", "c", "d", "e"], 5).expect("a wait");
        assert_eq!(many.label.as_deref(), Some("6 tasks"));
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
}
