//! Read-only Channel context derived from the currently authorized catalog.
use crate::protocol::ChannelSummarySource;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedChannelThread {
    pub channel_id: String,
    pub root_message_id: String,
    pub name: Option<String>,
}

/// The marker a transcript line carries when its message is a thread root.
///
/// The `Opened threads` block at the top of a read keys threads by an opaque
/// root message id, and a reader working down the transcript never turns back
/// to cross-reference it. A root message whose thread took the work would then
/// read as if nobody picked it up, and a derived Summary written from that
/// reading calls it unclaimed. Putting the thread on the message line itself
/// makes the fact visible where the judgement is formed.
pub fn thread_root_marker(threads: &[OpenedChannelThread], message_id: &str) -> Option<String> {
    let markers = threads
        .iter()
        .filter(|thread| thread.root_message_id == message_id)
        .map(|thread| {
            format!(
                "[thread={}: picked up; work continues in the thread]",
                thread.channel_id
            )
        })
        .collect::<Vec<_>>();
    if markers.is_empty() {
        None
    } else {
        Some(markers.join(" "))
    }
}

pub fn render_channel_read_context(
    summary: Option<&str>,
    source: Option<&ChannelSummarySource>,
    threads: &[OpenedChannelThread],
) -> String {
    // Escape markup delimiters so user-authored text cannot forge mirror record markers.
    let mut output = String::from("## Channel context (read-only)\n");
    if let Some(summary) = summary.filter(|value| !value.trim().is_empty()) {
        let written = source.map(summary_source_label).unwrap_or_default();
        output.push_str(&format!("\nSummary ({written}derived; may lag recent messages; where it contradicts the transcript or the thread list below, they win):\n"));
        for line in summary.lines() {
            output.push_str(&format!("  {}\n", line.replace('<', "&lt;")));
        }
    } else {
        output.push_str("\nSummary: unavailable.\n");
    }
    if !threads.is_empty() {
        output.push_str("\nOpened threads (root message → thread Channel; continue thread-specific work there). Every root message listed here has been picked up, so never report it as unclaimed:\n");
        for thread in threads {
            let value = serde_json::to_string(thread).expect("thread fields serialize");
            output.push_str(&format!("  {}\n", value.replace('<', "\\u003c")));
        }
    }
    output
}

/// `by <agent> through #<sequence> at <time>; `: who wrote a summary and how far it reads.
fn summary_source_label(source: &ChannelSummarySource) -> String {
    let through = source
        .through_sequence
        .map(|sequence| format!(" through #{sequence}"))
        .unwrap_or_default();
    format!(
        "by {}{through} at {}; ",
        source.author.agent_name.replace('<', "&lt;"),
        source.generated_at.replace('<', "&lt;")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn thread(root: &str, channel: &str) -> OpenedChannelThread {
        OpenedChannelThread {
            channel_id: channel.into(),
            root_message_id: root.into(),
            name: None,
        }
    }

    #[test]
    fn a_thread_marks_its_root_as_picked_up() {
        let threads = [thread("root-1", "thread-a"), thread("root-1", "thread-b")];
        let marker = thread_root_marker(&threads, "root-1").expect("root has threads");
        assert_eq!(marker.matches("picked up; work continues").count(), 2);
        assert!(marker.contains("thread=thread-a"));
    }

    #[test]
    fn a_message_without_a_thread_carries_no_marker() {
        let threads = [thread("root-1", "thread-a")];
        assert!(thread_root_marker(&threads, "root-2").is_none());
        assert!(thread_root_marker(&[], "root-1").is_none());
    }

    #[test]
    fn the_context_says_the_thread_list_beats_the_derived_summary() {
        let output = render_channel_read_context(
            Some("four items unclaimed"),
            None,
            &[thread("root-1", "thread-a")],
        );
        assert!(
            output
                .contains("where it contradicts the transcript or the thread list below, they win")
        );
        assert!(output.contains("never report it as unclaimed"));
        assert!(output.contains("\"channelId\":\"thread-a\""));
    }

    #[test]
    fn the_context_names_who_wrote_the_summary_and_how_far_it_reads() {
        let source: ChannelSummarySource = serde_json::from_value(serde_json::json!({
            "author": { "kind": "run", "runId": "run-1", "agentName": "claude" },
            "generatedAt": "2026-10-02T08:57:23.000Z",
            "throughSequence": 65,
        }))
        .unwrap();
        let output = render_channel_read_context(Some("summary"), Some(&source), &[]);
        assert!(output.contains(
            "Summary (by claude through #65 at 2026-10-02T08:57:23.000Z; derived; may lag recent messages;"
        ));
    }
}
