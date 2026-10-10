//! Conversation activity from a runtime's own plan and results
//! (docs/design/conversation-activity.md §3.2, §3.4).
//!
//! An Agent keeps its plan with its runtime's plan tool (Claude Code
//! `TodoWrite`, Codex `turn/plan/updated`, ACP `plan`). The runtime sees every
//! change, so it — not the Agent — reports what changed: completed steps and
//! the pull requests the Agent opened become activity entries, and the step in
//! progress becomes the presence intent line. The Agent never has to narrate.

use std::collections::HashSet;
use std::time::{Duration, Instant};

use serde_json::Value;
use xmatrix_cli_core::agent_instance_connection::AgentInstanceConnectionClient;
use xmatrix_cli_core::protocol::{
    AgentInstanceClientMessage, ChannelActivity, ChannelActivityPlanStep,
    ChannelActivityPlanStepStatus,
};

/// At most one plan entry per window; a turn's end flushes what is pending.
const PLAN_ENTRY_INTERVAL: Duration = Duration::from_secs(15);
const MAX_STEPS: usize = 30;
const MAX_COMPLETED: usize = 10;
const MAX_TEXT_CHARS: usize = 200;

/// One step as a runtime's plan tool reported it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ObservedStep {
    pub(crate) text: String,
    pub(crate) status: ChannelActivityPlanStepStatus,
    /// Present-tense form for the intent line (`Running tests`), when the
    /// runtime has one; the imperative `text` is used otherwise.
    pub(crate) active_form: Option<String>,
}

/// What a caller should publish after an observation.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct ActivityEffects {
    /// A new intent line; `Some(None)` clears it.
    pub(crate) intent: Option<Option<String>>,
    pub(crate) activity: Vec<ChannelActivity>,
}

#[derive(Debug, Default)]
pub(crate) struct ChannelActivityReporter {
    steps: Vec<ObservedStep>,
    /// Completed steps already reported (or already complete when first seen).
    reported: HashSet<String>,
    /// Completed since the last plan entry, oldest first.
    pending: Vec<String>,
    /// The plan changed shape and has not been announced yet.
    announce: bool,
    intent: Option<String>,
    last_entry_at: Option<Instant>,
    pull_requests: HashSet<String>,
}

fn one_line(text: &str) -> Option<String> {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() {
        return None;
    }
    if text.chars().count() <= MAX_TEXT_CHARS {
        return Some(text);
    }
    let mut bounded: String = text.chars().take(MAX_TEXT_CHARS - 1).collect();
    bounded.push('…');
    Some(bounded)
}

impl ChannelActivityReporter {
    /// Observe the whole plan as the runtime now reports it.
    pub(crate) fn observe_plan(
        &mut self,
        steps: Vec<ObservedStep>,
        now: Instant,
    ) -> ActivityEffects {
        let steps: Vec<ObservedStep> = steps.into_iter().take(MAX_STEPS).collect();
        let known: HashSet<&str> = self.steps.iter().map(|step| step.text.as_str()).collect();
        let first = self.steps.is_empty();
        let replaced = !first && !steps.iter().any(|step| known.contains(step.text.as_str()));
        if first || replaced {
            // A new plan: what it already lists as done happened before anyone
            // could see it, so it is part of the announcement, not news.
            self.reported = steps
                .iter()
                .filter(|step| step.status == ChannelActivityPlanStepStatus::Completed)
                .map(|step| step.text.clone())
                .collect();
            self.pending.clear();
            self.announce = !steps.is_empty();
        } else {
            for step in &steps {
                if step.status == ChannelActivityPlanStepStatus::Completed
                    && self.reported.insert(step.text.clone())
                {
                    self.pending.push(step.text.clone());
                }
            }
        }
        self.steps = steps;
        let intent = self
            .steps
            .iter()
            .find(|step| step.status == ChannelActivityPlanStepStatus::InProgress)
            .map(|step| {
                step.active_form
                    .clone()
                    .unwrap_or_else(|| step.text.clone())
            });
        let mut effects = ActivityEffects::default();
        if intent != self.intent {
            self.intent = intent.clone();
            effects.intent = Some(intent);
        }
        let due = self
            .last_entry_at
            .is_none_or(|at| now.duration_since(at) >= PLAN_ENTRY_INTERVAL);
        if due {
            effects.activity.extend(self.take_plan_entry(now));
        }
        effects
    }

    /// Report what is still pending, whatever the window; called at turn end.
    pub(crate) fn flush(&mut self, now: Instant) -> Vec<ChannelActivity> {
        self.take_plan_entry(now).into_iter().collect()
    }

    /// The intent line is only true while a turn runs.
    pub(crate) fn turn_ended(&mut self) -> Option<Option<String>> {
        self.intent.take().map(|_| None)
    }

    fn take_plan_entry(&mut self, now: Instant) -> Option<ChannelActivity> {
        if !self.announce && self.pending.is_empty() {
            return None;
        }
        let completed: Vec<String> = self
            .pending
            .drain(..)
            .rev()
            .take(MAX_COMPLETED)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        self.announce = false;
        self.last_entry_at = Some(now);
        Some(ChannelActivity::Plan {
            completed,
            in_progress: self
                .steps
                .iter()
                .find(|step| step.status == ChannelActivityPlanStepStatus::InProgress)
                .map(|step| step.text.clone()),
            steps: self
                .steps
                .iter()
                .map(|step| ChannelActivityPlanStep {
                    text: step.text.clone(),
                    status: step.status,
                })
                .collect(),
        })
    }

    /// Pull requests a command's output shows it created, each reported once.
    pub(crate) fn observe_command_output(
        &mut self,
        command: &str,
        output: &str,
    ) -> Vec<ChannelActivity> {
        if !creates_pull_request(command) {
            return Vec::new();
        }
        pull_request_urls(output)
            .into_iter()
            .filter(|url| self.pull_requests.insert(url.clone()))
            .map(|url| ChannelActivity::PullRequest {
                url,
                repository: None,
                number: None,
            })
            .collect()
    }
}

fn status(value: Option<&str>) -> Option<ChannelActivityPlanStepStatus> {
    match value? {
        "pending" => Some(ChannelActivityPlanStepStatus::Pending),
        "in_progress" | "inProgress" => Some(ChannelActivityPlanStepStatus::InProgress),
        "completed" => Some(ChannelActivityPlanStepStatus::Completed),
        _ => None,
    }
}

fn observed(
    text: Option<&str>,
    state: Option<&str>,
    active_form: Option<&str>,
) -> Option<ObservedStep> {
    Some(ObservedStep {
        text: one_line(text?)?,
        status: status(state)?,
        active_form: active_form.and_then(one_line),
    })
}

/// Claude Code `TodoWrite` input: `{ todos: [{ content, status, activeForm }] }`.
pub(crate) fn claude_todo_steps(input: &Value) -> Option<Vec<ObservedStep>> {
    let todos = input.get("todos")?.as_array()?;
    Some(
        todos
            .iter()
            .filter_map(|todo| {
                observed(
                    todo.get("content").and_then(Value::as_str),
                    todo.get("status").and_then(Value::as_str),
                    todo.get("activeForm").and_then(Value::as_str),
                )
            })
            .collect(),
    )
}

/// Codex `turn/plan/updated` params: `{ plan: [{ step, status }] }`.
pub(crate) fn codex_plan_steps(params: &Value) -> Option<Vec<ObservedStep>> {
    let plan = params.get("plan")?.as_array()?;
    Some(
        plan.iter()
            .filter_map(|step| {
                observed(
                    step.get("step").and_then(Value::as_str),
                    step.get("status").and_then(Value::as_str),
                    None,
                )
            })
            .collect(),
    )
}

/// ACP `plan` session update: `{ entries: [{ content, status }] }`.
pub(crate) fn acp_plan_steps(update: &Value) -> Option<Vec<ObservedStep>> {
    let entries = update.get("entries")?.as_array()?;
    Some(
        entries
            .iter()
            .filter_map(|entry| {
                observed(
                    entry.get("content").and_then(Value::as_str),
                    entry.get("status").and_then(Value::as_str),
                    None,
                )
            })
            .collect(),
    )
}

/// Whether a shell command creates a pull request, however it is wrapped.
pub(crate) fn creates_pull_request(command: &str) -> bool {
    let words: Vec<&str> = command
        .split(|c: char| c.is_whitespace() || matches!(c, ';' | '&' | '|' | '(' | ')' | '"' | '\''))
        .filter(|word| !word.is_empty())
        .collect();
    words
        .windows(3)
        .any(|window| window[0].ends_with("gh") && window[1] == "pr" && window[2] == "create")
}

/// GitHub pull request URLs in a command's output, in order, without repeats.
pub(crate) fn pull_request_urls(output: &str) -> Vec<String> {
    let mut urls = Vec::new();
    for (index, _) in output.match_indices("https://github.com/") {
        let candidate: String = output[index..]
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | ':' | '.' | '-' | '_'))
            .collect();
        let parts: Vec<&str> = candidate.trim_end_matches(['.', ':']).split('/').collect();
        // https: / "" / github.com / owner / repo / pull / number
        if parts.len() == 7
            && parts[5] == "pull"
            && !parts[3].is_empty()
            && !parts[4].is_empty()
            && parts[6].parse::<u64>().is_ok_and(|number| number > 0)
        {
            let url = parts.join("/");
            if !urls.contains(&url) {
                urls.push(url);
            }
        }
    }
    urls
}

/// Report one activity entry. A plan entry is best effort, like traces; a pull
/// request's is kept until the Hub answers it. A Hub that does not list
/// `channel_activity` would close the socket on it, so nothing is sent.
pub(crate) fn publish_channel_activity(
    relay: &AgentInstanceConnectionClient,
    channel_id: &str,
    activity: ChannelActivity,
) {
    if !relay.hub_accepts("channel_activity") {
        return;
    }
    let request_id = uuid::Uuid::new_v4().to_string();
    // The next plan entry supersedes a lost one. A pull request is reported
    // once, and the report is what subscribes its conversation.
    let reported_once = matches!(activity, ChannelActivity::PullRequest { .. });
    let report = AgentInstanceClientMessage::ChannelActivity {
        request_id: Some(request_id.clone()),
        channel_id: channel_id.to_string(),
        activity,
    };
    if reported_once {
        relay.send_report(request_id, report);
    } else if let Err(err) = relay.send_message(report) {
        eprintln!("failed to publish channel activity: {err}");
    }
}

/// Set or clear the presence intent line; nothing else in presence changes.
pub(crate) fn publish_intent(relay: &AgentInstanceConnectionClient, intent: Option<String>) {
    let _ = relay.send_message(AgentInstanceClientMessage::PresenceUpdate {
        request_id: None,
        status: None,
        activity: None,
        files: None,
        // An empty line clears the intent on the Hub.
        intent: Some(intent.unwrap_or_default()),
        git_branch: None,
        capabilities: None,
        runtime_state: None,
        goal: None,
        model: None,
        models: None,
        effort: None,
        commands: None,
        parameters: None,
        status_chips: None,
        usage: None,
    });
}

/// Publish whatever an observation produced.
pub(crate) fn publish_effects(
    relay: &AgentInstanceConnectionClient,
    channel_id: &str,
    effects: ActivityEffects,
) {
    if let Some(intent) = effects.intent {
        publish_intent(relay, intent);
    }
    for activity in effects.activity {
        publish_channel_activity(relay, channel_id, activity);
    }
}

/// The command line of a Codex `commandExecution` item, which the app-server
/// gives either as one string or as its words.
pub(crate) fn codex_command_text(item: &Value) -> Option<String> {
    match item.get("command") {
        Some(Value::String(command)) => Some(command.clone()),
        Some(Value::Array(words)) => Some(
            words
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(" "),
        ),
        _ => None,
    }
}

/// Codex reports its plan with `turn/plan/updated`, each command it ran as a
/// completed `commandExecution` item, and the end of its turn.
pub(crate) fn observe_codex_activity(
    reporter: &mut ChannelActivityReporter,
    relay: &AgentInstanceConnectionClient,
    channel_id: &str,
    method: Option<&str>,
    params: &Value,
) {
    let now = Instant::now();
    match method {
        Some("turn/plan/updated") => {
            if let Some(steps) = codex_plan_steps(params) {
                publish_effects(relay, channel_id, reporter.observe_plan(steps, now));
            }
        }
        Some("item/completed") => {
            let Some(item) = params.get("item") else {
                return;
            };
            if item.get("type").and_then(Value::as_str) != Some("commandExecution") {
                return;
            }
            let Some(command) = codex_command_text(item) else {
                return;
            };
            let output = item
                .get("aggregatedOutput")
                .and_then(Value::as_str)
                .unwrap_or_default();
            for activity in reporter.observe_command_output(&command, output) {
                publish_channel_activity(relay, channel_id, activity);
            }
        }
        Some("turn/completed") => {
            for activity in reporter.flush(now) {
                publish_channel_activity(relay, channel_id, activity);
            }
            if let Some(intent) = reporter.turn_ended() {
                publish_intent(relay, intent);
            }
        }
        _ => {}
    }
}

/// An ACP runtime reports its plan as a `plan` session update.
pub(crate) fn observe_acp_plan(
    reporter: &mut ChannelActivityReporter,
    relay: &AgentInstanceConnectionClient,
    channel_id: &str,
    update: &Value,
) {
    if let Some(steps) = acp_plan_steps(update) {
        publish_effects(
            relay,
            channel_id,
            reporter.observe_plan(steps, Instant::now()),
        );
    }
}

/// The end of an ACP turn: report what is pending and clear the intent line.
pub(crate) fn finish_acp_turn(
    reporter: &mut ChannelActivityReporter,
    relay: &AgentInstanceConnectionClient,
    channel_id: &str,
) {
    for activity in reporter.flush(Instant::now()) {
        publish_channel_activity(relay, channel_id, activity);
    }
    if let Some(intent) = reporter.turn_ended() {
        publish_intent(relay, intent);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn step(text: &str, status: ChannelActivityPlanStepStatus) -> ObservedStep {
        ObservedStep {
            text: text.into(),
            status,
            active_form: None,
        }
    }

    use ChannelActivityPlanStepStatus::{Completed, InProgress, Pending};

    fn completed_of(activity: &ChannelActivity) -> Vec<String> {
        match activity {
            ChannelActivity::Plan { completed, .. } => completed.clone(),
            _ => panic!("not a plan entry"),
        }
    }

    #[test]
    fn a_new_plan_is_announced_once_and_sets_the_intent() {
        let start = Instant::now();
        let mut reporter = ChannelActivityReporter::default();
        let effects = reporter.observe_plan(
            vec![
                ObservedStep {
                    text: "Run tests".into(),
                    status: InProgress,
                    active_form: Some("Running tests".into()),
                },
                step("Open PR", Pending),
            ],
            start,
        );
        assert_eq!(effects.intent, Some(Some("Running tests".into())));
        assert_eq!(effects.activity.len(), 1);
        assert!(completed_of(&effects.activity[0]).is_empty());
        // The same plan again changes nothing.
        let again = reporter.observe_plan(
            vec![
                ObservedStep {
                    text: "Run tests".into(),
                    status: InProgress,
                    active_form: Some("Running tests".into()),
                },
                step("Open PR", Pending),
            ],
            start + Duration::from_secs(60),
        );
        assert_eq!(again, ActivityEffects::default());
    }

    #[test]
    fn completions_inside_the_window_coalesce_into_one_entry() {
        let start = Instant::now();
        let mut reporter = ChannelActivityReporter::default();
        reporter.observe_plan(
            vec![
                step("a", InProgress),
                step("b", Pending),
                step("c", Pending),
            ],
            start,
        );
        let early = reporter.observe_plan(
            vec![
                step("a", Completed),
                step("b", InProgress),
                step("c", Pending),
            ],
            start + Duration::from_secs(5),
        );
        assert!(early.activity.is_empty(), "inside the window: pending");
        assert_eq!(early.intent, Some(Some("b".into())));
        let later = reporter.observe_plan(
            vec![
                step("a", Completed),
                step("b", Completed),
                step("c", InProgress),
            ],
            start + Duration::from_secs(20),
        );
        assert_eq!(later.activity.len(), 1);
        assert_eq!(completed_of(&later.activity[0]), vec!["a", "b"]);
        // Nothing is reported twice, and a flush with nothing pending is silent.
        assert!(reporter.flush(start + Duration::from_secs(21)).is_empty());
    }

    #[test]
    fn a_turn_end_flushes_and_clears_the_intent() {
        let start = Instant::now();
        let mut reporter = ChannelActivityReporter::default();
        reporter.observe_plan(vec![step("a", InProgress)], start);
        reporter.observe_plan(vec![step("a", Completed)], start + Duration::from_secs(1));
        let flushed = reporter.flush(start + Duration::from_secs(2));
        assert_eq!(completed_of(&flushed[0]), vec!["a"]);
        assert_eq!(
            reporter.turn_ended(),
            None,
            "no step in progress: no intent to clear"
        );
        reporter.observe_plan(vec![step("a", Completed), step("b", InProgress)], start);
        assert_eq!(reporter.turn_ended(), Some(None));
    }

    #[test]
    fn a_replaced_plan_announces_without_replaying_old_completions() {
        let start = Instant::now();
        let mut reporter = ChannelActivityReporter::default();
        reporter.observe_plan(vec![step("old", Completed)], start);
        let replaced = reporter.observe_plan(
            vec![step("done already", Completed), step("new", InProgress)],
            start + Duration::from_secs(30),
        );
        assert_eq!(replaced.activity.len(), 1);
        assert!(completed_of(&replaced.activity[0]).is_empty());
    }

    #[test]
    fn runtime_plan_shapes_parse_into_steps() {
        let claude = claude_todo_steps(&json!({ "todos": [
            { "content": "Run  tests\n", "status": "in_progress", "activeForm": "Running tests" },
            { "content": "", "status": "pending" },
            { "content": "Ship", "status": "unknown" },
        ]}))
        .unwrap();
        assert_eq!(claude.len(), 1);
        assert_eq!(claude[0].text, "Run tests");
        assert_eq!(claude[0].active_form.as_deref(), Some("Running tests"));
        let codex = codex_plan_steps(&json!({ "plan": [
            { "step": "Write CLI", "status": "inProgress" },
            { "step": "Web", "status": "pending" },
        ]}))
        .unwrap();
        assert_eq!(codex[0].status, InProgress);
        let acp = acp_plan_steps(&json!({ "entries": [
            { "content": "Deploy", "status": "completed", "priority": "high" },
        ]}))
        .unwrap();
        assert_eq!(acp[0].status, Completed);
    }

    #[test]
    fn only_a_pull_request_creation_reports_its_url_once() {
        let mut reporter = ChannelActivityReporter::default();
        let output = "Creating pull request\nhttps://github.com/LambdaLabsHQ/xmatrix/pull/3043\n";
        assert!(
            reporter
                .observe_command_output("gh pr view 3043", output)
                .is_empty()
        );
        let created = reporter.observe_command_output(
            "cd /repo && gh pr create --title \"x\" --body-file /tmp/b",
            output,
        );
        assert_eq!(
            created,
            vec![ChannelActivity::PullRequest {
                url: "https://github.com/LambdaLabsHQ/xmatrix/pull/3043".into(),
                repository: None,
                number: None,
            }]
        );
        assert!(
            reporter
                .observe_command_output("gh pr create --fill", output)
                .is_empty()
        );
        assert_eq!(
            pull_request_urls(
                "see https://github.com/a/b/pull/7. and https://github.com/a/b/issues/8"
            ),
            vec!["https://github.com/a/b/pull/7"]
        );
    }
}
