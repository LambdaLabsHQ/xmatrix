// Channel history bootstrap for a newly woken Agent instance.
//
// A daemon-spawned run joins its channel with `historyLimit` 0, so a brand new
// instance starts knowing nothing about what the channel has been discussing
// and re-asks questions the channel already answered. Read the channel history
// once, up front, and fold it into the first prompt as read-only context.
//
// Deliberately not a join replay: replayed history arrives as channel messages
// and every one of them becomes a runtime turn, so the instance would answer
// months-old messages one by one. This reads history out of band instead and
// hands it to the runtime as prompt text.
//
// It reads through the same `/api/channels/:id/history` walk that
// `xmatrix channel history` uses, because that is the only read that covers a
// channel completely. The Agent WebSocket `get_channel_history` cannot: its
// only backward cursor is a timestamp, and an `afterSequence` walk starts at
// sequence 1, so it silently drops the sequence-zero root message that a thread
// channel's history is synthesized with — exactly the message that gives a
// thread its context.
//
// A reborn skips this. Reborn resumes the provider session (`resume: true` on
// the Hub spawn command, which is what sets `XMATRIX_RESUME_REQUESTED`), so the
// replacement already has the conversation it was reading before; re-reading
// the channel would only duplicate it. The live-update rejoin sets the same
// flag for the same reason.
//
// A resumed run with no message of its own goes further and carries no
// bootstrap prompt at all: the resumed session already holds it, and a
// bootstrap-only first prompt is a model turn nobody asked for. A version
// handoff or a reborn comes back silent, and the next channel message is its
// first turn.

use crate::protocol::ChannelMessage;
use std::sync::OnceLock;
use xmatrix_cli_core::channel_read_context::{OpenedChannelThread, thread_root_marker};

/// Rendered at the initial channel join, where the Hub token and the join's
/// history limit are both in hand, and consumed when each backend builds its
/// first prompt.
static CHANNEL_HISTORY_BLOCK: OnceLock<String> = OnceLock::new();

/// Whether this run only resumes a session and has nothing to say: then it
/// is prompted with nothing, not even the bootstrap. Pure so the rule is
/// testable.
fn resumed_without_message(resume_requested: bool, initial_message: Option<&str>) -> bool {
    resume_requested && initial_message.is_none_or(|message| message.trim().is_empty())
}

/// Ceiling on the rendered transcript. A 400-message channel renders to roughly
/// 80k characters, so ordinary channels are read in full and never trimmed.
/// Override with `XMATRIX_CHANNEL_HISTORY_BOOTSTRAP_MAX_CHARS`.
const DEFAULT_MAX_CHARS: usize = 200_000;

/// The channel this instance should read before its first turn, or `None` when
/// the bootstrap does not apply. Pure so the launch-path rule is testable.
fn channel_history_bootstrap_target(
    auto_join_channel_id: Option<&str>,
    resume_requested: bool,
    join_replayed_history: bool,
    disabled: bool,
) -> Option<String> {
    if disabled || resume_requested || join_replayed_history {
        return None;
    }
    auto_join_channel_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn max_chars_from_env() -> usize {
    std::env::var("XMATRIX_CHANNEL_HISTORY_BOOTSTRAP_MAX_CHARS")
        .ok()
        .and_then(|value| value.trim().parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_MAX_CHARS)
}

/// Read the channel this instance was started in, once, at join time. Any
/// failure is reported and dropped: an instance that cannot read history must
/// still start.
pub(crate) async fn prime_channel_history_bootstrap(
    hub_url: &str,
    token: &str,
    auto_join_channel_id: &str,
    join_history_limit: u32,
) {
    let target = channel_history_bootstrap_target(
        Some(auto_join_channel_id),
        crate::env_flag("XMATRIX_RESUME_REQUESTED"),
        join_history_limit > 0,
        matches!(
            std::env::var("XMATRIX_CHANNEL_HISTORY_BOOTSTRAP")
                .unwrap_or_default()
                .trim(),
            "0" | "false" | "no" | "off"
        ),
    );
    let Some(channel_id) = target else {
        return;
    };
    // The transcript and the directory context are independent reads; the
    // directory one lists the whole authorized catalog and takes seconds on
    // its own, so reading them one after the other paid for both on every
    // launch.
    let (history, read_context) = tokio::join!(
        xmatrix_cli_channel::load_full_channel_history(hub_url, token, &channel_id),
        xmatrix_cli_channel::load_channel_read_context(hub_url, token, &channel_id),
    );
    let messages = match history {
        Ok(messages) => messages,
        Err(error) => {
            eprintln!("⚠ Could not read channel history for {channel_id}: {error}");
            return;
        }
    };
    if let Some(through) = messages.iter().filter_map(|message| message.sequence).max() {
        xmatrix_cli_core::agent_instance_connection::record_prompt_carried_history(
            &channel_id,
            through,
        );
    }
    let skip_message_id = std::env::var("XMATRIX_INITIAL_MESSAGE_ID").unwrap_or_default();
    let (context, threads) = match read_context {
        Ok(context) => (context.text, context.threads),
        Err(error) => {
            eprintln!("⚠ Could not read channel context for {channel_id}: {error}");
            (
                String::from("Channel Summary and opened-thread context unavailable.\n"),
                Vec::new(),
            )
        }
    };
    let history = render_channel_history_block(
        &channel_id,
        &messages,
        Some(skip_message_id.trim()).filter(|value| !value.is_empty()),
        max_chars_from_env(),
        xmatrix_cli_core::instant::now_utc_rfc3339().as_deref(),
        &threads,
    );
    let _ = CHANNEL_HISTORY_BLOCK.set(format!("{context}\n{}", history.unwrap_or_default()));
}

/// Register with the Hub while the channel history bootstrap reads, instead of
/// reading only after registration returns.
///
/// Neither depends on the other: the bootstrap is plain HTTP reads authorized
/// by the run credential, which the Hub verifies without the Agent socket. The
/// one ordering the protocol needs is that the bootstrap finishes before the
/// initial join, because the join's `afterSequence` comes from what the
/// bootstrap read; this returns only after both are done, so the caller's join
/// still follows the read. A failed registration returns at once and drops the
/// read, since nothing will join.
pub(crate) async fn register_while_priming<T, E>(
    register: impl std::future::Future<Output = Result<T, E>>,
    prime: impl std::future::Future<Output = ()>,
) -> Result<T, E> {
    tokio::pin!(register);
    tokio::pin!(prime);
    let mut primed = false;
    loop {
        tokio::select! {
            registered = &mut register => {
                let registered = registered?;
                if !primed {
                    prime.await;
                }
                return Ok(registered);
            }
            () = &mut prime, if !primed => primed = true,
        }
    }
}

/// Append the channel's history to the bootstrap prompt so the first turn
/// carries it.
pub(crate) fn with_channel_history_bootstrap(bootstrap_prompt: Option<String>) -> Option<String> {
    if resumed_without_message(
        crate::env_flag("XMATRIX_RESUME_REQUESTED"),
        std::env::var("XMATRIX_INITIAL_MESSAGE").ok().as_deref(),
    ) {
        return None;
    }
    let Some(block) = CHANNEL_HISTORY_BLOCK.get() else {
        return bootstrap_prompt;
    };
    Some(match bootstrap_prompt {
        Some(prompt) => format!("{prompt}\n\n{block}"),
        None => block.clone(),
    })
}

/// One transcript line: the UTC instant, then how long before the read it was.
///
/// The age is the part that matters. An instance that only repeats "3m ago"
/// cannot be wrong about it, where one that subtracts `sentAt` from whatever
/// clock it believes in is wrong by its machine's UTC offset.
fn render_history_entry(
    message: &ChannelMessage,
    read_at: Option<&str>,
    threads: &[OpenedChannelThread],
) -> String {
    let sequence = message
        .sequence
        .map(|value| format!(" #{value}"))
        .unwrap_or_default();
    let age = read_at
        .and_then(|now| xmatrix_cli_core::instant::relative_age(&message.sent_at, now))
        .map(|age| format!(" ({age})"))
        .unwrap_or_default();
    // A thread root carries its thread state on its own line; the `Opened
    // threads` block above is keyed by an id nobody turns back to look up.
    let thread_marker = thread_root_marker(threads, &message.message_id)
        .map(|marker| format!(" {marker}"))
        .unwrap_or_default();
    // Activity and superseded reports fold to one line, as they do on the web.
    if let Some(folded) = xmatrix_cli_core::protocol::folded_history_line(message) {
        return format!(
            "{}{age}{sequence} {} [{}] [messageId={}]{thread_marker}: {folded}\n",
            message.sent_at, message.from.label, message.from.kind, message.message_id
        );
    }
    let mut entry = format!(
        "{}{age}{sequence} {} [{}] [messageId={}]{thread_marker}:\n",
        message.sent_at, message.from.label, message.from.kind, message.message_id
    );
    if message.recalled_at.is_some() {
        entry.push_str("  (recalled)\n");
        return entry;
    }
    for line in message.body.lines() {
        entry.push_str("  ");
        entry.push_str(line);
        entry.push('\n');
    }
    // A bare count told the instance a file existed but not what it was or how
    // to open it, so it asked the sender to resend. Name each one and point at
    // the read that saves it locally; downloading every image in the channel
    // up front would slow every launch for files most turns never look at.
    for attachment in message.attachments.as_deref().unwrap_or_default() {
        entry.push_str(&format!(
            "  [attachment] {} ({}, {} bytes) — run `xmatrix channel history {}` to save it \
             locally and read it from the printed `local:` path\n",
            attachment.name, attachment.mime_type, attachment.size, message.channel_id
        ));
    }
    entry
}

/// Render the transcript oldest-first. When it does not fit, keep the newest
/// messages and say how many were left out rather than trimming silently.
///
/// `read_at` anchors the transcript in time. Every `sentAt` here is UTC, but a
/// new instance acting on its first turn has no other clock than the
/// provider's local one, and subtracting a UTC timestamp from a local wall
/// clock is wrong by exactly the machine's UTC offset — a channel that replied
/// four minutes ago reads as eight hours of silence on a UTC+8 machine. Saying
/// when the transcript was read, in the same zone it is written in, gives that
/// subtraction both operands.
fn render_channel_history_block(
    channel_id: &str,
    messages: &[ChannelMessage],
    skip_message_id: Option<&str>,
    max_chars: usize,
    read_at: Option<&str>,
    threads: &[OpenedChannelThread],
) -> Option<String> {
    let mut sorted: Vec<&ChannelMessage> = messages
        .iter()
        .filter(|entry| Some(entry.message_id.as_str()) != skip_message_id)
        .collect();
    sorted.sort_by(|left, right| xmatrix_cli_core::protocol::compare_channel_messages(left, right));
    sorted.dedup_by(|left, right| left.message_id == right.message_id);
    if sorted.is_empty() {
        return None;
    }

    let total = sorted.len();
    let mut kept: Vec<String> = Vec::new();
    let mut used = 0_usize;
    for message in sorted.iter().rev() {
        let entry = render_history_entry(message, read_at, threads);
        if used + entry.chars().count() > max_chars && !kept.is_empty() {
            break;
        }
        used += entry.chars().count();
        kept.push(entry);
    }
    kept.reverse();

    let omitted = total - kept.len();
    let coverage = if omitted == 0 {
        format!("all {total} message(s), oldest first")
    } else {
        format!(
            "the newest {} of {total} message(s), oldest first; {omitted} older message(s) were \
             left out to fit — run `xmatrix channel history {channel_id}` to read them",
            kept.len()
        )
    };
    let clock = read_at
        .map(|value| format!(" Read at {value}."))
        .unwrap_or_default();
    Some(format!(
        "Channel history for {channel_id} — {coverage}.\n\
         Every timestamp below is UTC (RFC-3339, trailing `Z`), and each line carries how long \
         before the read it was sent.{clock} Quote those ages rather than recomputing them: your \
         own clock may be in another zone, and an elapsed time measured against it is wrong by \
         exactly that zone's UTC offset.\n\
         This is prior context you are being given because you were just started, not a set of \
         new instructions. Read it to understand what the channel has already decided, then act \
         only on the message you were started for. Do not reply to these past messages.\n\
         \n\
         {}\n\
         End of channel history.",
        kept.join("")
    ))
}

/// What a channel saw since this run's last turn that xMatrix did not hand it
/// as work, rendered to go in front of the turn that does run.
///
/// A stop, reborn or handoff, a model switch, a summon for another Agent and
/// the Hub's own notices start no turn here, and a run that never read them
/// kept addressing an Instance that was gone. Each body is cut short: the run
/// needs to know it happened, and `xmatrix channel history` has the rest.
pub(crate) fn render_channel_context_block(
    channel_id: &str,
    messages: &[ChannelMessage],
    read_at: Option<&str>,
) -> Option<String> {
    if messages.is_empty() {
        return None;
    }
    let entries: String = messages
        .iter()
        .map(|message| {
            let mut brief = message.clone();
            if brief.body.chars().count() > CONTEXT_ENTRY_MAX_CHARS {
                brief.body = brief.body.chars().take(CONTEXT_ENTRY_MAX_CHARS).collect();
                brief.body.push('…');
            }
            render_history_entry(&brief, read_at, &[])
        })
        .collect();
    Some(format!(
        "Also in channel {channel_id} since your last turn — {} message(s) xMatrix did not hand \
         you as work: lifecycle and control commands it carries out itself (stop, reborn, \
         handoff, model), summons addressed to other Agents, and its own notices. Know them; do \
         not reply to them or carry them out. `xmatrix list` shows who is live now.\n\
         \n\
         {entries}\
         End of channel context.",
        messages.len()
    ))
}

const CONTEXT_ENTRY_MAX_CHARS: usize = 600;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_resumed_run_with_nothing_to_say_is_not_prompted() {
        assert!(resumed_without_message(true, None));
        assert!(resumed_without_message(true, Some("  ")));
        assert!(!resumed_without_message(true, Some("continue the review")));
        assert!(!resumed_without_message(false, None));
    }

    fn message(message_id: &str, sequence: u64, label: &str, body: &str) -> ChannelMessage {
        serde_json::from_value(serde_json::json!({
            "messageId": message_id,
            "channelId": "channel-1",
            "sequence": sequence,
            "from": { "kind": "user", "label": label, "userId": "user-1", "email": "a@b.c" },
            "body": body,
            "sentAt": format!("2026-08-10T17:0{sequence}:00.000Z"),
        }))
        .expect("channel message fixture")
    }

    /// A peer never got a turn for a stop, so its next turn has to say it.
    #[test]
    fn context_since_the_last_turn_names_the_stop_and_is_not_an_assignment() {
        assert_eq!(render_channel_context_block("channel-1", &[], None), None);
        let stop = message("m-7", 7, "Yiming Hu", "@codex:2:stop wrong branch");
        let notice = message("m-8", 8, "xMatrix", &"x".repeat(700));
        let block = render_channel_context_block(
            "channel-1",
            &[stop, notice],
            Some("2026-08-10T17:09:00.000Z"),
        )
        .expect("context block");
        assert!(
            block.starts_with("Also in channel channel-1 since your last turn — 2 message(s)"),
            "{block}"
        );
        assert!(
            block.contains("do not reply to them or carry them out"),
            "{block}"
        );
        assert!(
            block.contains(
                "(2m ago) #7 Yiming Hu [user] [messageId=m-7]:\n  @codex:2:stop wrong branch\n"
            ),
            "{block}"
        );
        assert!(
            block.contains(&format!("  {}…\n", "x".repeat(600))),
            "{block}"
        );
        assert!(block.ends_with("End of channel context."), "{block}");
    }

    #[test]
    fn activity_and_superseded_reports_are_one_line_in_launch_context() {
        let mut activity = message("m-1", 1, "claude:1", "✓ Run e2e");
        activity.metadata = Some(serde_json::json!({
            "xmatrixProvenance": "activity",
            "xmatrixActivity": { "kind": "plan", "completed": ["Run e2e"], "steps": [] },
        }));
        let mut superseded = message("m-2", 2, "claude:1", "Progress: writing the CLI\nmore");
        superseded.superseded_by = Some("m-3".into());
        let spoken = message("m-3", 3, "claude:1", "CLI merged into PR 2");
        let block = render_channel_history_block(
            "channel-1",
            &[activity, superseded, spoken],
            None,
            10_000,
            None,
            &[],
        )
        .expect("history block");
        assert!(block.contains("[messageId=m-1]: ▸ ✓ Run e2e\n"), "{block}");
        assert!(
            block.contains("[messageId=m-2]: [superseded by m-3] Progress: writing the CLI…\n"),
            "{block}"
        );
        assert!(
            block.contains("[messageId=m-3]:\n  CLI merged into PR 2\n"),
            "{block}"
        );
    }

    #[test]
    fn an_attachment_names_itself_and_how_to_open_it() {
        let mut screenshot = message("m-1", 1, "Yiming Hu", "hmmmm");
        screenshot.attachments = Some(vec![
            serde_json::from_value(serde_json::json!({
                "id": "att-1",
                "kind": "image",
                "name": "image.png",
                "mimeType": "image/png",
                "size": 210_195,
                "channelId": "channel-1",
                "messageId": "m-1",
            }))
            .expect("attachment fixture"),
        ]);
        let block =
            render_channel_history_block("channel-1", &[screenshot], None, 10_000, None, &[])
                .expect("history block");
        assert!(
            block.contains(
                "  hmmmm\n  [attachment] image.png (image/png, 210195 bytes) — run `xmatrix \
                 channel history channel-1` to save it locally and read it from the printed \
                 `local:` path\n"
            ),
            "{block}"
        );
    }

    #[test]
    fn a_new_instance_reads_the_channel_it_was_started_in() {
        assert_eq!(
            channel_history_bootstrap_target(Some("channel-1"), false, false, false),
            Some("channel-1".to_string())
        );
    }

    #[test]
    fn a_reborn_keeps_its_resumed_context_instead_of_re_reading() {
        assert_eq!(
            channel_history_bootstrap_target(Some("channel-1"), true, false, false),
            None
        );
    }

    #[test]
    fn a_join_that_already_replayed_history_is_not_duplicated() {
        assert_eq!(
            channel_history_bootstrap_target(Some("channel-1"), false, true, false),
            None
        );
    }

    #[test]
    fn a_run_without_a_channel_or_with_the_bootstrap_disabled_reads_nothing() {
        assert_eq!(
            channel_history_bootstrap_target(None, false, false, false),
            None
        );
        assert_eq!(
            channel_history_bootstrap_target(Some("  "), false, false, false),
            None
        );
        assert_eq!(
            channel_history_bootstrap_target(Some("channel-1"), false, false, true),
            None
        );
    }

    #[test]
    fn history_renders_oldest_first_and_marks_itself_read_only() {
        let block = render_channel_history_block(
            "channel-1",
            &[
                message("m2", 2, "Yiming Hu", "second"),
                message("m1", 1, "Legend Wang", "first"),
            ],
            None,
            10_000,
            None,
            &[],
        )
        .expect("history block");
        let first = block.find("first").expect("first message");
        let second = block.find("second").expect("second message");
        assert!(first < second, "history must read oldest first");
        assert!(block.contains("all 2 message(s)"));
        assert!(block.contains("Do not reply to these past messages."));
        assert!(block.contains("#1 Legend Wang [user]"));
    }

    #[test]
    fn the_summoning_message_is_not_repeated_as_history() {
        let block = render_channel_history_block(
            "channel-1",
            &[
                message("m1", 1, "Legend Wang", "first"),
                message("m2", 2, "Yiming Hu", "the assignment"),
            ],
            Some("m2"),
            10_000,
            None,
            &[],
        )
        .expect("history block");
        assert!(!block.contains("the assignment"));
        assert!(block.contains("all 1 message(s)"));
    }

    #[test]
    fn an_oversized_channel_keeps_the_newest_and_discloses_what_it_dropped() {
        let messages: Vec<ChannelMessage> = (1..=20)
            .map(|index| message(&format!("m{index}"), index, "Legend Wang", &"x".repeat(100)))
            .collect();
        let block = render_channel_history_block("channel-1", &messages, None, 600, None, &[])
            .expect("history block");
        assert!(block.contains("of 20 message(s)"));
        assert!(block.contains("left out to fit"));
        assert!(block.contains("xmatrix channel history channel-1"));
        assert!(block.contains("#20"), "the newest message must be kept");
        assert!(!block.contains("#1 "), "the oldest message must be dropped");
    }

    #[test]
    fn the_transcript_states_its_zone_and_when_it_was_read() {
        let block = render_channel_history_block(
            "channel-1",
            &[message("m1", 1, "Legend Wang", "first")],
            None,
            10_000,
            Some("2026-08-10T17:31:00Z"),
            &[],
        )
        .expect("history block");
        assert!(block.contains("Every timestamp below is UTC"));
        assert!(block.contains("Read at 2026-08-10T17:31:00Z."));
    }

    /// The transcript answers "how long ago" itself so that no reader has to
    /// subtract — the subtraction is what produced an eight-hour report of a
    /// four-minute gap.
    #[test]
    fn each_line_carries_how_long_before_the_read_it_was_sent() {
        let block = render_channel_history_block(
            "channel-1",
            &[
                message("m1", 1, "Legend Wang", "first"),
                message("m2", 2, "Yiming Hu", "second"),
            ],
            None,
            10_000,
            Some("2026-08-10T20:04:00Z"),
            &[],
        )
        .expect("history block");
        assert!(block.contains("2026-08-10T17:01:00.000Z (3h ago) #1 Legend Wang"));
        assert!(block.contains("2026-08-10T17:02:00.000Z (3h ago) #2 Yiming Hu"));
    }

    #[test]
    fn an_unreadable_clock_leaves_the_transcript_unstamped() {
        let block = render_channel_history_block(
            "channel-1",
            &[message("m1", 1, "Legend Wang", "first")],
            None,
            10_000,
            None,
            &[],
        )
        .expect("history block");
        assert!(block.contains("Every timestamp below is UTC"));
        assert!(!block.contains("Read at"));
        assert!(
            !block.contains(" ago)"),
            "with no clock there is no anchor, so no age may be invented"
        );
    }

    /// The `Opened threads` block keys threads by an id nobody turns back to
    /// look up, so a root whose thread took the work read as untouched and a
    /// derived Summary called it unclaimed. The line itself now says so.
    #[test]
    fn a_thread_root_line_carries_its_thread_state() {
        let threads = [
            OpenedChannelThread {
                channel_id: "2cf53953".to_string(),
                root_message_id: "m1".to_string(),
                name: Some("space scope".to_string()),
            },
            OpenedChannelThread {
                channel_id: "44149ba6".to_string(),
                root_message_id: "m2".to_string(),
                name: None,
            },
        ];
        let block = render_channel_history_block(
            "channel-1",
            &[
                message("m1", 1, "Yiming Hu", "only show the current Space"),
                message("m2", 2, "Yiming Hu", "effort is not shown"),
                message("m3", 3, "Yiming Hu", "no thread yet"),
            ],
            None,
            10_000,
            None,
            &threads,
        )
        .expect("history block");
        assert!(block.contains(
            "[messageId=m1] [thread=2cf53953: picked up; work continues in the thread]:"
        ));
        assert!(block.contains(
            "[messageId=m2] [thread=44149ba6: picked up; work continues in the thread]:"
        ));
        assert!(block.contains("[messageId=m3]:"));
        assert_eq!(block.matches("[thread=").count(), 2);
    }

    #[test]
    fn an_empty_channel_contributes_no_block() {
        assert!(render_channel_history_block("channel-1", &[], None, 10_000, None, &[]).is_none());
    }

    // Registration and the history read each take seconds against the
    // production Hub. Run one after the other, a launch paid for both before
    // it could join.
    #[tokio::test(start_paused = true)]
    async fn the_history_read_overlaps_registration_instead_of_following_it() {
        use std::time::Duration;
        let started = tokio::time::Instant::now();
        let registered = register_while_priming(
            async {
                tokio::time::sleep(Duration::from_secs(5)).await;
                Ok::<_, ()>("agent")
            },
            async { tokio::time::sleep(Duration::from_secs(4)).await },
        )
        .await;
        assert_eq!(registered, Ok("agent"));
        assert_eq!(started.elapsed(), Duration::from_secs(5));
    }

    // The join's afterSequence comes from the read, so the join may only start
    // once the read is done, even when registration answers first.
    #[tokio::test(start_paused = true)]
    async fn registration_that_answers_first_still_waits_for_the_read() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::time::Duration;
        let read_done = AtomicBool::new(false);
        let started = tokio::time::Instant::now();
        let registered = register_while_priming(
            async {
                tokio::time::sleep(Duration::from_secs(1)).await;
                Ok::<_, ()>(())
            },
            async {
                tokio::time::sleep(Duration::from_secs(3)).await;
                read_done.store(true, Ordering::SeqCst);
            },
        )
        .await;
        assert_eq!(registered, Ok(()));
        assert!(read_done.load(Ordering::SeqCst));
        assert_eq!(started.elapsed(), Duration::from_secs(3));
    }

    // Nothing joins after a failed registration, so the read is not waited on.
    #[tokio::test(start_paused = true)]
    async fn a_failed_registration_returns_without_waiting_for_the_read() {
        use std::time::Duration;
        let started = tokio::time::Instant::now();
        let registered = register_while_priming(
            async {
                tokio::time::sleep(Duration::from_secs(1)).await;
                Err::<(), _>("rejected")
            },
            async { tokio::time::sleep(Duration::from_secs(30)).await },
        )
        .await;
        assert_eq!(registered, Err("rejected"));
        assert_eq!(started.elapsed(), Duration::from_secs(1));
    }
}
