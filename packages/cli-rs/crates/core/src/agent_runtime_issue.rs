//! Per-instance symptoms derived from the existing normalized runtime stream.
//! No provider names, error-text matching, or raw diagnostics cross this boundary.

use std::collections::HashSet;

use serde_json::Value;

use crate::protocol::{
    AgentRuntimeIssue, AgentRuntimeIssueKind, AgentRuntimeNotice, AgentRuntimeState,
};

pub(crate) const NO_PROGRESS_MS: u64 = 5 * 60_000;
const MAX_OPEN_TOOLS: usize = 128;

#[derive(Debug, Clone, Default)]
pub(crate) struct RuntimeIssueTracker {
    pub(crate) issue: Option<AgentRuntimeIssue>,
    pub(crate) notice: Option<AgentRuntimeNotice>,
    active: bool,
    channel: Option<String>,
    thread: Option<String>,
    turn: Option<String>,
    execution: Option<String>,
    last_progress: u64,
    waiting: bool,
    tools: HashSet<String>,
    // If correlation is missing or over capacity, avoid guessing a stall
    // while a tool could still be running. The next turn resets this bound.
    uncorrelated_tool: bool,
}

impl RuntimeIssueTracker {
    pub(crate) fn public_state(&self) -> (Option<AgentRuntimeIssue>, Option<AgentRuntimeNotice>) {
        (self.issue.clone(), self.notice.clone())
    }

    pub(crate) fn observe_presence(
        &mut self,
        previous_status: Option<&str>,
        status: Option<&str>,
        state: Option<&AgentRuntimeState>,
        now: u64,
    ) {
        let execution = state
            .and_then(|s| s.execution.as_ref())
            .map(|e| e.execution_id.as_str());
        let new_execution = execution.is_some() && execution != self.execution.as_deref();
        if status == Some("busy") && previous_status != Some("busy") || new_execution {
            *self = Self {
                active: true,
                last_progress: now,
                ..Self::default()
            };
        }
        if let Some(state) = state {
            if state.active_channel_id.is_some() {
                self.channel = state.active_channel_id.clone();
            }
            if state.active_thread_id.is_some() {
                self.thread = state.active_thread_id.clone();
            }
            if state.active_turn_id.is_some() {
                self.turn = state.active_turn_id.clone();
            }
            if execution.is_some() {
                self.execution = execution.map(str::to_owned);
            }
        }
        let waiting = state.is_some_and(|s| s.waiting.is_some());
        if waiting != self.waiting {
            self.last_progress = now;
            if self
                .issue
                .as_ref()
                .is_some_and(|i| i.kind == AgentRuntimeIssueKind::Stalled)
            {
                self.issue = None;
            }
        }
        self.waiting = waiting;
        if status.is_some_and(|s| s != "busy") {
            self.active = false;
            self.tools.clear();
            self.uncorrelated_tool = false;
            self.clear_transient_issue();
        }
    }

    pub(crate) fn observe_trace(&mut self, channel: &str, trace: &Value, now: u64) {
        if trace.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
            return;
        }
        let Some(phase) = trace.get("phase").and_then(Value::as_str) else {
            return;
        };
        let Some(payload) = trace.get("payload").filter(|v| v.is_object()) else {
            return;
        };
        let thread = string(payload, "threadId");
        let turn = string(payload, "turnId");
        if self.channel.as_deref().is_some_and(|id| id != channel)
            || mismatched(self.turn.as_deref(), turn)
            || (turn.is_none() && mismatched(self.thread.as_deref(), thread))
        {
            return;
        }
        let category = string(payload, "category").unwrap_or_default();
        let status = string(payload, "status").unwrap_or_default();
        if phase == "runtime_event" && category == "notice" {
            if matches!(status, "info" | "warning" | "error" | "unknown") {
                self.notice = Some(AgentRuntimeNotice {
                    severity: status.into(),
                    since_millis: now,
                });
            }
            return;
        }
        let start = phase == "turn_started"
            || phase == "runtime_event" && category == "turn" && status == "started";
        if start {
            // Busy presence normally precedes the trace. A start marker only
            // creates a turn when inactive; repeated markers do not hide retries.
            if !self.active {
                if self
                    .issue
                    .as_ref()
                    .is_some_and(|i| i.kind == AgentRuntimeIssueKind::Failed)
                {
                    return;
                }
                *self = Self {
                    active: true,
                    last_progress: now,
                    ..Self::default()
                };
            }
            self.bind_scope(channel, thread, turn);
            if self.issue.is_none() {
                self.last_progress = now;
            }
            return;
        }
        // An explicit failure may arrive after idle presence (ACP settlement).
        let failed = phase == "turn_failed"
            || phase == "runtime_event" && category == "error" && status == "failed";
        if failed {
            self.bind_scope(channel, thread, turn);
            self.fail(now);
            return;
        }
        if !self.active {
            return;
        }
        self.bind_scope(channel, thread, turn);
        if phase == "runtime_event" && category == "connection" && status == "retrying" {
            self.set_issue(AgentRuntimeIssueKind::Retrying, now);
        } else if matches!(phase, "turn_completed" | "turn_cancelled")
            || phase == "runtime_event"
                && category == "turn"
                && matches!(status, "completed" | "cancelled")
        {
            self.active = false;
            self.issue = None;
            self.tools.clear();
            self.uncorrelated_tool = false;
        } else if matches!(
            phase,
            "tool_call"
                | "tool_call_update"
                | "tool_call_started"
                | "tool_call_completed"
                | "tool_result"
        ) || phase == "runtime_event" && category == "tool"
        {
            self.observe_tool(phase, status, payload);
            self.progress(now);
        } else if phase == "assistant_delta" && string(payload, "delta").is_some()
            || phase == "runtime_event"
                && matches!(category, "reasoning" | "message" | "plan")
                && matches!(status, "started" | "delta" | "completed" | "info")
        {
            self.progress(now);
        }
    }

    pub(crate) fn observe_failure(&mut self, channel: Option<&str>, now: u64) {
        if channel.is_some_and(|id| self.channel.as_deref().is_some_and(|active| active != id)) {
            return;
        }
        self.fail(now);
    }

    pub(crate) fn tick(&mut self, now: u64) {
        if self
            .notice
            .as_ref()
            .is_some_and(|n| n.severity == "info" && now.saturating_sub(n.since_millis) >= 60_000)
        {
            self.notice = None;
        }
        if self.active
            && !self.waiting
            && self.tools.is_empty()
            && !self.uncorrelated_tool
            && self.issue.is_none()
            && now.saturating_sub(self.last_progress) >= NO_PROGRESS_MS
        {
            self.set_issue(AgentRuntimeIssueKind::Stalled, self.last_progress);
        }
    }

    fn bind_scope(&mut self, channel: &str, thread: Option<&str>, turn: Option<&str>) {
        self.channel.get_or_insert_with(|| channel.to_owned());
        if let Some(thread) = thread {
            self.thread.get_or_insert_with(|| thread.to_owned());
        }
        if let Some(turn) = turn {
            self.turn.get_or_insert_with(|| turn.to_owned());
        }
    }

    fn progress(&mut self, now: u64) {
        self.last_progress = now;
        self.clear_transient_issue();
    }

    fn clear_transient_issue(&mut self) {
        if self
            .issue
            .as_ref()
            .is_some_and(|i| i.kind != AgentRuntimeIssueKind::Failed)
        {
            self.issue = None;
        }
    }

    fn fail(&mut self, now: u64) {
        self.active = false;
        self.set_issue(AgentRuntimeIssueKind::Failed, now);
    }

    fn set_issue(&mut self, kind: AgentRuntimeIssueKind, since_millis: u64) {
        if self
            .issue
            .as_ref()
            .is_some_and(|i| i.kind == AgentRuntimeIssueKind::Failed || i.kind == kind)
        {
            return;
        }
        self.issue = Some(AgentRuntimeIssue { kind, since_millis });
    }

    fn observe_tool(&mut self, phase: &str, status: &str, payload: &Value) {
        let item = payload.get("item").unwrap_or(&Value::Null);
        let update = payload.get("update").unwrap_or(&Value::Null);
        let id = string(payload, "itemId")
            .or_else(|| string(item, "id"))
            .or_else(|| string(item, "tool_use_id"))
            .or_else(|| string(update, "toolCallId"));
        let status = string(update, "status").unwrap_or(status);
        let ended = matches!(phase, "tool_result" | "tool_call_completed")
            || matches!(status, "completed" | "failed" | "cancelled");
        if ended {
            if let Some(id) = id {
                self.tools.remove(id);
            }
        } else if matches!(phase, "tool_call_started" | "tool_call")
            || matches!(status, "started" | "pending" | "in_progress")
        {
            if let Some(id) = id.filter(|id| id.len() <= 512) {
                if self.tools.len() < MAX_OPEN_TOOLS {
                    self.tools.insert(id.to_owned());
                } else {
                    self.uncorrelated_tool = true;
                }
            } else {
                self.uncorrelated_tool = true;
            }
        }
    }
}

fn string<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
}

fn mismatched(expected: Option<&str>, actual: Option<&str>) -> bool {
    matches!((expected, actual), (Some(a), Some(b)) if a != b)
}

#[cfg(test)]
#[path = "tests/agent_runtime_issue.rs"]
mod tests;
