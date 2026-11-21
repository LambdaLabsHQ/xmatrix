//! Conversation activity a runtime observes about its Run's own work
//! (docs/design/conversation-activity.md §3.2): the pull requests the Agent
//! opened become activity entries. The Agent never has to narrate them.
//!
//! A runtime's plan tool (Claude Code `TodoWrite`, Codex `turn/plan/updated`,
//! ACP `plan`) is not reported: newer models keep track of multi-step work
//! without a written checklist, so a plan is no fact every Run has.

use std::collections::HashSet;

use serde_json::Value;
use xmatrix_cli_core::agent_instance_connection::AgentInstanceConnectionClient;
use xmatrix_cli_core::protocol::{AgentInstanceClientMessage, ChannelActivity};

#[derive(Debug, Default)]
pub(crate) struct ChannelActivityReporter {
    pull_requests: HashSet<String>,
}

impl ChannelActivityReporter {
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

/// Report one activity entry, kept until the Hub answers it: the report is
/// what subscribes its conversation to the pull request. A Hub that does not
/// list `channel_activity` would close the socket on it, so nothing is sent.
pub(crate) fn publish_channel_activity(
    relay: &AgentInstanceConnectionClient,
    channel_id: &str,
    activity: ChannelActivity,
) {
    if !relay.hub_accepts("channel_activity") {
        return;
    }
    let request_id = uuid::Uuid::new_v4().to_string();
    let report = AgentInstanceClientMessage::ChannelActivity {
        request_id: Some(request_id.clone()),
        channel_id: channel_id.to_string(),
        activity,
    };
    relay.send_report(request_id, report);
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

/// Codex reports each command it ran as a completed `commandExecution` item.
pub(crate) fn observe_codex_activity(
    reporter: &mut ChannelActivityReporter,
    relay: &AgentInstanceConnectionClient,
    channel_id: &str,
    method: Option<&str>,
    params: &Value,
) {
    if method != Some("item/completed") {
        return;
    }
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

#[cfg(test)]
mod tests {
    use super::*;

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
