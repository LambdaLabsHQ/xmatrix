// Reading an agent's goal state back out of what it said: session updates,
// assistant text, and the transcript on disk.

/// Best-effort parse of Grok ACP tool/session updates into AgentGoalStatus.
/// Grok's goal loop surfaces progress through the `update_goal` tool and
/// occasional assistant text; structured fields vary by build, so accept
/// several common shapes.
use std::io::Seek;
use std::io::SeekFrom;
use std::path::Path;
use std::path::PathBuf;

use serde_json::Value;

use crate::runtime_claude_turn::claude_transcript_cwd;
use crate::runtime_claude_turn::normalize_cwd_for_compare;
use crate::{GoalCommand, config, protocol, unix_millis_now};

pub(crate) fn grok_goal_status_from_session_update(
    update: &Value,
) -> Option<protocol::AgentGoalStatus> {
    let session_update = update.get("sessionUpdate").and_then(Value::as_str);
    if !matches!(session_update, Some("tool_call") | Some("tool_call_update")) {
        return None;
    }
    let name = update
        .get("title")
        .or_else(|| update.get("toolName"))
        .or_else(|| update.get("name"))
        .or_else(|| update.get("kind"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let name_l = name.to_ascii_lowercase();
    let raw = update
        .get("rawInput")
        .or_else(|| update.get("input"))
        .or_else(|| update.get("content"))
        .cloned()
        .unwrap_or(Value::Null);
    let raw_text = raw.as_str().unwrap_or("").to_string();
    let looks_like_goal = name_l.contains("goal")
        || raw_text.to_ascii_lowercase().contains("goal")
        || raw.get("status").and_then(Value::as_str).is_some_and(|s| {
            matches!(
                s.to_ascii_lowercase().as_str(),
                "active" | "completed" | "complete" | "paused" | "cleared" | "failed"
            )
        }) && (raw.get("objective").is_some() || raw.get("goal").is_some());
    if !looks_like_goal {
        return None;
    }

    let objective = raw
        .get("objective")
        .or_else(|| raw.get("goal"))
        .or_else(|| raw.get("condition"))
        .or_else(|| raw.get("message"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or({
            // rawInput may be a free-form string like "completed: ship feature"
            if raw_text.is_empty() {
                None
            } else {
                Some(raw_text)
            }
        });

    let status = raw
        .get("status")
        .or_else(|| raw.get("state"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_ascii_lowercase())
        .or_else(|| {
            if name_l.contains("complete") {
                Some("completed".to_string())
            } else if name_l.contains("pause") {
                Some("paused".to_string())
            } else if name_l.contains("clear") {
                Some("cleared".to_string())
            } else {
                None
            }
        });

    let active = match status.as_deref() {
        Some("completed" | "complete" | "cleared" | "failed" | "paused") => Some(false),
        Some("active" | "running" | "in_progress" | "blocked") => Some(true),
        _ if name_l.contains("update_goal") || name_l.contains("goal") => Some(true),
        _ => None,
    };

    if objective.is_none() && status.is_none() && active.is_none() {
        return None;
    }

    Some(protocol::AgentGoalStatus {
        active,
        objective,
        status,
        updated_at: Some(unix_millis_now().to_string()),
        ..Default::default()
    })
}

pub(crate) fn grok_goal_status_from_assistant_text(
    text: &str,
    command: Option<&GoalCommand>,
) -> Option<protocol::AgentGoalStatus> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    let lower = text.to_ascii_lowercase();
    // Control-command acks: prefer command context when we know what we sent.
    if matches!(command, Some(GoalCommand::Clear))
        || lower.contains("goal cleared")
        || lower.starts_with("cleared goal")
    {
        return Some(protocol::AgentGoalStatus {
            active: Some(false),
            objective: None,
            status: Some("cleared".to_string()),
            updated_at: Some(unix_millis_now().to_string()),
            ..Default::default()
        });
    }
    if matches!(command, Some(GoalCommand::Pause)) || lower.contains("goal paused") {
        return Some(protocol::AgentGoalStatus {
            active: Some(false),
            objective: None,
            status: Some("paused".to_string()),
            updated_at: Some(unix_millis_now().to_string()),
            ..Default::default()
        });
    }
    if lower.contains("no goal") || lower.contains("no active goal") {
        return Some(protocol::AgentGoalStatus {
            active: Some(false),
            objective: None,
            status: None,
            updated_at: Some(unix_millis_now().to_string()),
            ..Default::default()
        });
    }
    None
}

/// Parses one Claude transcript line into a goal status. Claude's goal
/// evaluator appends `{"type":"attachment","attachment":{"type":"goal_status",
/// "met":bool,"condition":…,"reason":…}}` records to the session transcript
/// after each evaluation (stream-json stdout carries no goal events as of
/// 2.1.199, so the transcript is the only structured source).
pub(crate) fn claude_goal_status_from_transcript_line(
    value: &Value,
) -> Option<protocol::AgentGoalStatus> {
    let attachment = value.get("attachment")?;
    if attachment.get("type").and_then(Value::as_str) != Some("goal_status") {
        return None;
    }
    let met = attachment.get("met").and_then(Value::as_bool)?;
    let objective = attachment
        .get("condition")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    Some(protocol::AgentGoalStatus {
        active: Some(!met),
        objective,
        status: Some(if met { "complete" } else { "active" }.to_string()),
        updated_at: Some(unix_millis_now().to_string()),
        reason: attachment
            .get("reason")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        next_action: attachment
            .get("nextAction")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        ..Default::default()
    })
}

/// Derives a goal status from the ack text Claude returns for the pure
/// control commands (bare `/goal` and `/goal clear`), which never reach the
/// evaluator and so never write a transcript `goal_status` record:
/// `Goal active: <condition> (<state>)`, `Goal cleared: <condition>`,
/// `No goal set. …`. Only called on turns we submitted as goal commands, so
/// prefix matching cannot misfire on ordinary model output.
pub(crate) fn claude_goal_status_from_result_text(text: &str) -> Option<protocol::AgentGoalStatus> {
    let text = text.trim();
    if let Some(rest) = text.strip_prefix("Goal active:") {
        // Drop the trailing parenthesized evaluator state, e.g. "(not yet
        // evaluated)"; keep the raw text when the shape is unexpected.
        let objective = match rest.rsplit_once(" (") {
            Some((condition, state)) if state.ends_with(')') => condition,
            _ => rest,
        };
        let objective = objective.trim();
        return Some(protocol::AgentGoalStatus {
            active: Some(true),
            objective: (!objective.is_empty()).then(|| objective.to_string()),
            status: Some("active".to_string()),
            updated_at: Some(unix_millis_now().to_string()),
            ..Default::default()
        });
    }
    if let Some(rest) = text.strip_prefix("Goal cleared") {
        let objective = rest.trim_start_matches(':').trim();
        return Some(protocol::AgentGoalStatus {
            active: Some(false),
            objective: (!objective.is_empty()).then(|| objective.to_string()),
            status: Some("cleared".to_string()),
            updated_at: Some(unix_millis_now().to_string()),
            ..Default::default()
        });
    }
    if text.starts_with("No goal set") {
        return Some(protocol::AgentGoalStatus {
            active: Some(false),
            objective: None,
            status: None,
            updated_at: Some(unix_millis_now().to_string()),
            ..Default::default()
        });
    }
    None
}

/// Locates the transcript file for a session id, verifying it belongs to
/// `cwd` the same way resume validation does (Claude keys the store by cwd;
/// an id can shadow an unrelated conversation from another directory).
pub(crate) fn find_claude_transcript(session_id: &str, cwd: &Path) -> Option<PathBuf> {
    let root = config::claude_projects_dir()?;
    let file_name = format!("{session_id}.jsonl");
    let entries = std::fs::read_dir(&root).ok()?;
    let want = normalize_cwd_for_compare(&cwd.to_string_lossy());
    for entry in entries.flatten() {
        let candidate = entry.path().join(&file_name);
        if !candidate.is_file() {
            continue;
        }
        if let Some(session_cwd) = claude_transcript_cwd(&candidate)
            && normalize_cwd_for_compare(&session_cwd).eq_ignore_ascii_case(&want)
        {
            return Some(candidate);
        }
    }
    None
}

/// What one poll of the transcript learned. Two facts ride the same read
/// because they arrive in the same file and re-reading it twice is how the
/// two views of one turn start disagreeing.
#[derive(Debug, Default)]
pub(crate) struct ClaudeTranscriptPoll {
    /// The goal changed and callers should republish it.
    pub(crate) goal_changed: bool,
    /// The reasoning effort the newest assistant record ran at, when the turn
    /// appended one.
    pub(crate) effort: Option<String>,
}

/// The reasoning effort an `assistant` transcript record ran at.
///
/// Only `assistant` records carry it, and only when the model supports
/// reasoning effort at all — a Haiku session records none, so a missing field
/// leaves the last known level standing rather than clearing it.
fn claude_effort_from_transcript_line(value: &Value) -> Option<String> {
    if value.get("type").and_then(Value::as_str) != Some("assistant") {
        return None;
    }
    value
        .get("effort")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|effort| !effort.is_empty())
        .map(|effort| effort.chars().take(64).collect())
}

/// Incrementally follows the session transcript for the two facts a turn
/// writes there and nowhere else: `goal_status` records — the claude-print
/// counterpart of the codex `thread/goal/updated` capture — and the
/// reasoning effort stamped on every `assistant` record.
///
/// The effort has no other source. `system/init` carries none, the stdout
/// `assistant` frame carries none, and `apply_flag_settings` answers a bare
/// `success`; the transcript is the only place Claude states the level a turn
/// actually ran at, which is why it is read here rather than assumed from
/// whatever this runtime last pinned (verified against 2.1.273: an unpinned
/// sonnet session records `high`, and a session launched `--effort high` then
/// switched to `max` records `max`).
///
/// Goals are polled at turn boundaries; the stream reader also reads effort
/// on model-bearing frames before tools can publish a reply. Each cursor
/// remembers a byte offset per transcript so each
/// poll only reads what the turn appended. The first poll of a transcript
/// reads it from the start, which also restores the goal badge after a
/// `--resume` respawn (the surviving records are in the resumed file).
pub(crate) struct ClaudeTranscriptWatcher {
    cwd: PathBuf,
    session_id: Option<String>,
    transcript_path: Option<PathBuf>,
    offset: u64,
    latest: Option<protocol::AgentGoalStatus>,
}

impl ClaudeTranscriptWatcher {
    /// `initial` is the goal a spawn context carried in, so a resumed instance
    /// shows its objective before the first turn produces one. It arrives here
    /// rather than being assigned afterwards: the watcher owns this state, and
    /// a caller reaching in to set it is how the two drift apart.
    pub(crate) fn new(cwd: Option<&str>, initial: Option<protocol::AgentGoalStatus>) -> Self {
        let cwd = cwd
            .map(PathBuf::from)
            .or_else(|| std::env::current_dir().ok())
            .unwrap_or_default();
        Self {
            cwd,
            session_id: None,
            transcript_path: None,
            offset: 0,
            latest: initial,
        }
    }

    /// A watcher already bound to a known transcript, so a test can exercise
    /// polling without going through session discovery first.
    #[cfg(test)]
    pub(crate) fn bound_to(cwd: PathBuf, session_id: &str, transcript: PathBuf) -> Self {
        Self {
            cwd,
            session_id: Some(session_id.to_string()),
            transcript_path: Some(transcript),
            offset: 0,
            latest: None,
        }
    }

    /// Whether discovery has bound this watcher to a transcript yet.
    #[cfg(test)]
    pub(crate) fn has_transcript(&self) -> bool {
        self.transcript_path.is_some()
    }

    /// The goal as last observed, for callers that report or attach it.
    pub(crate) fn current(&self) -> Option<&protocol::AgentGoalStatus> {
        self.latest.as_ref()
    }

    /// Reads whatever the turn appended: `goal_status` records and the effort
    /// on `assistant` records. A session-id change (fresh spawn or resume
    /// fork) re-runs transcript discovery and restarts from the top of the
    /// new file.
    pub(crate) fn poll(&mut self, session_id: Option<&str>) -> ClaudeTranscriptPoll {
        let mut poll = ClaudeTranscriptPoll::default();
        let Some(session_id) = session_id.map(str::trim).filter(|value| !value.is_empty()) else {
            return poll;
        };
        if self.session_id.as_deref() != Some(session_id) {
            self.session_id = Some(session_id.to_string());
            self.transcript_path = None;
            self.offset = 0;
        }
        if self.transcript_path.is_none() {
            self.transcript_path = find_claude_transcript(session_id, &self.cwd);
        }
        let Some(path) = self.transcript_path.as_ref() else {
            return poll;
        };
        let Ok(mut file) = std::fs::File::open(path) else {
            return poll;
        };
        if file.seek(SeekFrom::Start(self.offset)).is_err() {
            return poll;
        }
        let mut appended = String::new();
        if std::io::Read::read_to_string(&mut file, &mut appended).is_err() {
            // Mid-write UTF-8 boundary or transient read failure: retry the
            // same range on the next poll.
            return poll;
        }
        // Only consume complete lines; a partially flushed trailing line is
        // re-read next poll.
        let consumed = match appended.rfind('\n') {
            Some(end) => end + 1,
            None => return poll,
        };
        self.offset += consumed as u64;
        for line in appended[..consumed].lines() {
            // Two cheap substring gates before paying for a parse: this runs
            // over every line the turn appended, most of which are neither.
            let goal_line = line.contains("\"goal_status\"");
            let assistant_line = line.contains("\"effort\"");
            if !goal_line && !assistant_line {
                continue;
            }
            let Ok(value) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            if goal_line && let Some(goal) = claude_goal_status_from_transcript_line(&value) {
                self.latest = Some(goal);
                poll.goal_changed = true;
            }
            // Last write wins: a turn appends one assistant record per API
            // block, and the newest is the level in force now.
            if let Some(effort) = claude_effort_from_transcript_line(&value) {
                poll.effort = Some(effort);
            }
        }
        poll
    }

    /// Applies a status derived outside the transcript (control-command ack
    /// text), which supersedes whatever the transcript last said.
    pub(crate) fn apply(&mut self, goal: protocol::AgentGoalStatus) {
        self.latest = Some(goal);
    }

    pub(crate) fn clear(&mut self) {
        self.latest = None;
    }
}

pub(crate) fn goal_status_represents_absence(goal: &protocol::AgentGoalStatus) -> bool {
    goal.active == Some(false)
        && goal
            .objective
            .as_deref()
            .map(str::trim)
            .is_none_or(str::is_empty)
        && goal.status.as_deref().is_none_or(|status| {
            status.trim().is_empty()
                || status.eq_ignore_ascii_case("none")
                || status.eq_ignore_ascii_case("cleared")
        })
}
