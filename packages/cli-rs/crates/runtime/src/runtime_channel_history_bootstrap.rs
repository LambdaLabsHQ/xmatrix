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
// The Hub renders what goes in front of the first turn
// (`/api/channels/:id/launch-context`): which messages, in what words and
// within what budget. This file only places that text and records what it
// covers, so changing what a new Run reads first is a Hub deploy.
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

/// The Hub's rendering of the channel at the initial join, read where the Hub
/// token and the join's history limit are both in hand, and consumed when
/// each backend builds its first prompt.
static CHANNEL_HISTORY_BLOCK: OnceLock<String> = OnceLock::new();
/// The message this run was started for, as the same read returned it: who
/// wrote it and what it replies to, which the launch passes only as a body.
static STARTED_FOR: OnceLock<ChannelMessage> = OnceLock::new();
static STARTED_FOR_PROMPT: OnceLock<String> = OnceLock::new();
// The prompt read advances the join floor past these controls. Preserve their
// latest typed state for the runtime instead of leaving them only in prose.
static CHANNEL_CO_WRITE: OnceLock<crate::protocol::ChannelPageCoWrite> = OnceLock::new();

pub(crate) fn follow_bootstrap_co_write(
    relay: &xmatrix_cli_core::agent_instance_connection::AgentInstanceConnectionClient,
    channel_id: &str,
) {
    if let Some(instruction) = CHANNEL_CO_WRITE.get() {
        crate::runtime_page_co_write::follow(
            relay,
            channel_id,
            instruction,
            crate::non_empty_env("XMATRIX_INITIAL_MESSAGE").is_some(),
        );
    }
}

/// Whether this run only resumes a session and has nothing to say: then it
/// is prompted with nothing, not even the bootstrap. Pure so the rule is
/// testable.
fn resumed_without_message(resume_requested: bool, initial_message: Option<&str>) -> bool {
    resume_requested && initial_message.is_none_or(|message| message.trim().is_empty())
}

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

/// Read the channel this instance was started in, once, at join time. The Hub
/// chooses and renders what goes in front of the first turn
/// (`/api/channels/:id/launch-context`); this keeps only where it goes. Any
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
    let started_for = std::env::var("XMATRIX_INITIAL_MESSAGE_ID").unwrap_or_default();
    let started_for = Some(started_for.trim()).filter(|value| !value.is_empty());
    let context =
        match xmatrix_cli_channel::load_launch_context(hub_url, token, &channel_id, started_for)
            .await
        {
            Ok(context) => context,
            Err(error) => {
                eprintln!("⚠ Could not read channel history for {channel_id}: {error}");
                return;
            }
        };
    if let Some(instruction) = context.co_write {
        let _ = CHANNEL_CO_WRITE.set(instruction);
    }
    if let Some(through) = context.through_sequence {
        xmatrix_cli_core::agent_instance_connection::record_prompt_carried_history(
            &channel_id,
            through,
        );
        // The first prompt shows this history: the run has read it.
        xmatrix_cli_core::read_through::record(&channel_id, through);
    }
    if let Some(started_for) = context.started_for {
        let _ = STARTED_FOR.set(started_for);
    }
    if let Some(prompt) = context.started_for_prompt {
        let _ = STARTED_FOR_PROMPT.set(prompt);
    }
    if let Some(text) = context.text.filter(|text| !text.is_empty()) {
        let _ = CHANNEL_HISTORY_BLOCK.set(text);
    }
}

/// The message this run was started for, written as every later turn writes
/// a channel message: its channel and id, who sent it, and what it replies
/// to. The launch hands the body over on its own, so a message xMatrix posted
/// in reply to someone (a first message's summon) otherwise reads as a bare
/// command with nothing to answer. Unchanged when the read did not find it.
pub(crate) fn initial_message_turn(body: &str) -> String {
    render_started_for(
        STARTED_FOR.get(),
        STARTED_FOR_PROMPT.get().map(String::as_str),
        body,
    )
}

fn render_started_for(
    started_for: Option<&ChannelMessage>,
    hub_prompt: Option<&str>,
    body: &str,
) -> String {
    let Some(message) = started_for else {
        return body.to_string();
    };
    if let Some(prompt) = hub_prompt.filter(|_| message.body.trim() == body) {
        return prompt.to_string();
    }
    crate::format_incoming_channel_message_with_context(
        &message.channel_id,
        Some(&message.message_id),
        message.reply_to_message_id.as_deref(),
        message.reply_to.as_ref(),
        false,
        &message.from,
        message.metadata.as_ref(),
        body,
        None,
        None,
    )
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
fn render_history_entry(message: &ChannelMessage, read_at: Option<&str>) -> String {
    let sequence = message
        .sequence
        .map(|value| format!(" #{value}"))
        .unwrap_or_default();
    let age = read_at
        .and_then(|now| xmatrix_cli_core::instant::relative_age(&message.sent_at, now))
        .map(|age| format!(" ({age})"))
        .unwrap_or_default();
    // Who answers whom is read from replies, so a reply says which message it
    // answers, as a live turn's header does.
    let reply = message
        .reply_to_message_id
        .as_deref()
        .map(|parent| format!(" [replyToMessageId={parent}]"))
        .unwrap_or_default();
    // Activity folds to one line, as it does on the web.
    if let Some(folded) = xmatrix_cli_core::protocol::folded_history_line(message) {
        return format!(
            "{}{age}{sequence} {} [{}] [messageId={}]{reply}: {folded}\n",
            message.sent_at, message.from.label, message.from.kind, message.message_id
        );
    }
    let mut entry = format!(
        "{}{age}{sequence} {} [{}] [messageId={}]{reply}:\n",
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

/// What a channel saw since this run's last turn without starting a turn
/// here, rendered to go in front of the turn that does run.
///
/// A stop, reborn or handoff, a model switch, a summon for another Agent and
/// the Hub's own notices start no turn here, and a run that never read them
/// kept addressing an Instance that was gone. Each body is cut short: the run
/// needs to know it happened, and `xmatrix channel history` has the rest. The
/// messages say what each one was, so the block adds no reading of its own.
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
            render_history_entry(&brief, read_at)
        })
        .collect();
    Some(format!(
        "Also in channel {channel_id} since your last turn — {} message(s). `xmatrix list` \
         shows who is live now.\n\
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
    fn context_since_the_last_turn_names_the_stop() {
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

    /// A new conversation's first message that names no Agent: xMatrix picks
    /// one and summons it by replying to that message.
    fn first_message_and_its_summon() -> (ChannelMessage, ChannelMessage) {
        let question = message("m1", 1, "Wei", "Is this safe? Does it cost anything?");
        let mut summon = message("xmatrix-summon:m1", 2, "xMatrix", "@codex launch:force");
        summon.from.kind = "system".into();
        summon.reply_to_message_id = Some("m1".into());
        summon.reply_to = Some(
            serde_json::from_value(serde_json::json!({
                "messageId": "m1",
                "from": question.from,
                "bodyPreview": question.body,
                "sentAt": question.sent_at,
            }))
            .expect("reply context fixture"),
        );
        (question, summon)
    }

    /// Started for a summon, a run was handed `@codex launch:force` alone and
    /// read that as its whole task: it reported itself ready and left the
    /// question unanswered. The message now carries who sent it and the
    /// question it replies to, as a later turn's message does.
    #[test]
    fn the_message_a_run_was_started_for_reads_like_any_later_turn() {
        let (_, summon) = first_message_and_its_summon();
        let turn = render_started_for(Some(&summon), None, "@codex launch:force");
        assert!(
            turn.starts_with(
                "xMatrix channel channel-1 messageId=xmatrix-summon:m1 replyToMessageId=m1"
            ),
            "{turn}"
        );
        assert!(turn.contains(" from xMatrix [system]:"), "{turn}");
        assert!(
            turn.contains(
                "Reply context: xMatrix replied to [Wei] messageId=m1 \
                 preview=\"Is this safe? Does it cost anything?\""
            ),
            "{turn}"
        );
        assert!(turn.ends_with("@codex launch:force"), "{turn}");
        assert_eq!(render_started_for(None, None, "hello"), "hello");
        assert_eq!(
            render_started_for(Some(&summon), Some("Hub envelope"), "@codex launch:force"),
            "Hub envelope"
        );
        assert!(
            render_started_for(Some(&summon), Some("Old envelope"), "Recovery input")
                .ends_with("Recovery input")
        );
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
