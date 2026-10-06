//! Which Hub deliveries this connection acknowledges and drops before any
//! runtime sees them: its own echoes, the summon that spawned it, orientation,
//! and catch-up its first prompt already carried.

use std::sync::OnceLock;

use crate::protocol::{AgentInstanceServerMessage, SerializedAgent, cross_channel_reply_source};

/// Who this connection is as a channel author.
///
/// Both halves are needed to recognise this connection's own echo. The identity
/// is the Agent profile, which every live Instance of one Agent shares, so
/// matching on it alone makes two Instances of the same Agent deaf to each
/// other — each reads the other's message as its own echo and drops it. The
/// Instance is what makes an echo *mine*.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RegisteredAuthor {
    identity_id: String,
    instance_id: String,
}

/// The author registration assigned, when it assigned one.
///
/// `None` when registration named no Instance. That connection has nothing in
/// the channel that could echo back: the hub refuses an Agent append that
/// cannot name its exact live Instance, so it cannot have authored the message
/// being delivered.
pub(crate) fn registered_author_from(agent: &SerializedAgent) -> Option<RegisteredAuthor> {
    let instance_id = agent
        .instance_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    Some(RegisteredAuthor {
        identity_id: agent.id.clone(),
        instance_id: instance_id.to_string(),
    })
}

/// The hub fans every committed channel message back to all live sockets on
/// the channel, including the sender's own, and flags any delivery to a busy
/// instance with `interrupt_requested`. Without this shared filter an agent
/// that runs `xmatrix send` mid-turn receives its own echo and cancels its own
/// active turn. Every runtime consumes deliveries through this connection, so
/// the echo is acknowledged and dropped here instead of per-runtime guards.
/// History replay is not filtered: an instance's own messages remain valid
/// replayed context and never carry an interrupt.
///
/// Scoped to the Instance, not the Agent. Two live Instances of one Agent are
/// separate participants that must hear each other; matching the profile id
/// alone silently dropped every message they sent one another, which is how two
/// of them spent an afternoon writing the same change twice.
fn live_channel_delivery_is_own_echo(
    server_msg: &AgentInstanceServerMessage,
    registered_author: Option<&RegisteredAuthor>,
) -> bool {
    let Some(author) = registered_author else {
        return false;
    };
    matches!(
        server_msg,
        AgentInstanceServerMessage::ChannelMessageReceived { message, .. }
            if message.from.kind == "agent"
                && message
                    .from
                    .identity_id
                    .as_deref()
                    .is_some_and(|identity| sender_identity_is(identity, &author.identity_id))
                && message.from.instance_id.as_deref() == Some(author.instance_id.as_str())
    )
}

/// A reply to a cross-Channel link comes back into the link's Channel under the
/// link owner's name, so its sender never names the Instance that wrote it; the
/// relay names that Instance in its metadata instead. An Instance answering its
/// own link already knows its answer: live, it would interrupt the running
/// turn, and replayed as connect-time catch-up (after a restart) it would start
/// a turn about itself. Unlike an ordinary own message, the relay is not
/// context either, so both frames drop it.
///
/// Matched on the Instance id alone: the relay's Agent id is the sender
/// snapshot's, which for a registration-backed Run need not equal the id
/// registration confirmed here.
fn delivery_is_own_cross_channel_reply(
    server_msg: &AgentInstanceServerMessage,
    registered_author: Option<&RegisteredAuthor>,
) -> bool {
    let Some(author) = registered_author else {
        return false;
    };
    let message = match server_msg {
        AgentInstanceServerMessage::ChannelMessageReceived { message, .. }
        | AgentInstanceServerMessage::ChannelHistoryReplay { message, .. } => message,
        _ => return false,
    };
    cross_channel_reply_source(message.metadata.as_ref())
        .and_then(|relay| relay.replier_instance_id)
        .as_deref()
        == Some(author.instance_id.as_str())
}

/// The hub's product sender presentation stamps an Agent's `identity_id` as
/// `agent:<agent id>` whenever the id is not already `agent:`-prefixed — which
/// a Channel-summoned Instance's id never is — while registration confirms the
/// bare id. Both spellings name the same Agent.
fn sender_identity_is(sender_identity: &str, agent_id: &str) -> bool {
    sender_identity == agent_id
        || sender_identity
            .strip_prefix("agent:")
            .is_some_and(|bare| bare == agent_id)
}

/// Channel message that summoned this run, when the daemon spawned it.
///
/// The summoning message reaches the instance as its initial prompt instead of
/// through live delivery, so nothing acknowledges it. The hub keeps the agent's
/// channel cursor parked below that message, and every reconnect catch-up — plus
/// every later instance of the same agent — replays it and its whole backlog as
/// new work. Acknowledging it once on arrival lets the cursor move past it.
pub(crate) fn spawn_initial_message_id() -> Option<String> {
    std::env::var("XMATRIX_INITIAL_MESSAGE_ID")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// The summoning message, when it is still served to the run it spawned.
///
/// A summon commits before the instance it spawns exists, so it can never
/// arrive as a live `ChannelMessageReceived`: the only frame that ever carries
/// it is the connect-time `ChannelHistoryReplay` catch-up. Matching live
/// delivery alone therefore never fired for the case this guard exists for, and
/// the instance re-received its own summon as a fresh task.
///
/// A hub that parks the summoned agent's cursor never replays it at all; this
/// stays as the client-side half of that invariant, for hubs that do not.
fn delivery_is_spawn_summon_echo(
    server_msg: &AgentInstanceServerMessage,
    initial_message_id: Option<&str>,
) -> bool {
    let Some(initial_message_id) = initial_message_id else {
        return false;
    };
    let message = match server_msg {
        AgentInstanceServerMessage::ChannelMessageReceived { message, .. }
        | AgentInstanceServerMessage::ChannelHistoryReplay { message, .. } => message,
        _ => return false,
    };
    message.message_id == initial_message_id
}

/// Orientation the hub is serving rather than work it is assigning.
///
/// A fresh join's history window and the hub's own system facts about the
/// channel are both context: the instance should know them, and it should not
/// act on them. They are still acknowledged so the cursor advances and they are
/// never served again — only the turn is skipped.
///
/// An absent intent means work. A hub that predates the field must keep having
/// its deliveries executed rather than silently dropped, so this can only ever
/// remove spurious turns, never real ones.
fn delivery_is_context_only(server_msg: &AgentInstanceServerMessage) -> bool {
    let intent = match server_msg {
        AgentInstanceServerMessage::ChannelMessageReceived {
            delivery_intent, ..
        }
        | AgentInstanceServerMessage::ChannelHistoryReplay {
            delivery_intent, ..
        } => delivery_intent.as_deref(),
        _ => None,
    };
    intent == Some("context")
}

/// Whether this connection acknowledges a delivery and drops it, so that no
/// runtime ever sees it.
///
/// This is a cross-layer contract, not a classification: everything that
/// survives here is work, and a runtime may cancel whatever turn is currently
/// running to take it (see `event_requests_active_turn_interrupt`). Orientation
/// therefore has to be separated from work *here* — a runtime cannot recover
/// the distinction later, because catch-up frames carry no interrupt flag to
/// weigh.
///
/// Named and tested as one decision on purpose. Assembling the same three
/// predicates inline at the call site left the combination unnamed and
/// unverified, so reordering the reader could quietly let orientation through
/// as an interrupting task. Bypassing this now takes deleting the call.
pub(crate) fn delivery_is_acknowledged_and_dropped(
    server_msg: &AgentInstanceServerMessage,
    registered_author: Option<&RegisteredAuthor>,
    spawn_initial_message_id: Option<&str>,
) -> bool {
    live_channel_delivery_is_own_echo(server_msg, registered_author)
        || delivery_is_own_cross_channel_reply(server_msg, registered_author)
        || delivery_is_spawn_summon_echo(server_msg, spawn_initial_message_id)
        || delivery_is_context_only(server_msg)
        || delivery_was_carried_by_prompt(server_msg, PROMPT_CARRIED_HISTORY.get())
}

/// The newest channel message this run's first prompt already carried.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptCarriedHistory {
    pub channel_id: String,
    pub through_sequence: u64,
}

pub(crate) static PROMPT_CARRIED_HISTORY: OnceLock<PromptCarriedHistory> = OnceLock::new();

/// Record the channel history read into the first prompt, before joining.
///
/// A run woken with join limit 0 reads the channel itself, then joins; the hub
/// still serves connect-time catch-up from the agent's durable cursor, which a
/// previous instance of the same agent may have left far behind. Without this,
/// that backlog arrives a second time as fresh tasks — a stopped instance's
/// `/kill all` or summon, hours old, re-executed by its successor.
pub fn record_prompt_carried_history(channel_id: &str, through_sequence: u64) {
    let _ = PROMPT_CARRIED_HISTORY.set(PromptCarriedHistory {
        channel_id: channel_id.to_string(),
        through_sequence,
    });
}

/// The join floor this run can vouch for in `channel_id`: the newest message
/// its first prompt carried. Another channel's read says nothing here.
pub(crate) fn join_after_sequence(
    channel_id: &str,
    carried: Option<&PromptCarriedHistory>,
) -> Option<u64> {
    carried
        .filter(|carried| carried.channel_id == channel_id)
        .map(|carried| carried.through_sequence)
}

/// Catch-up the first prompt already showed this run as read-only history.
///
/// Only replay frames qualify: a live delivery is new by construction, even
/// when its sequence is not.
fn delivery_was_carried_by_prompt(
    server_msg: &AgentInstanceServerMessage,
    carried: Option<&PromptCarriedHistory>,
) -> bool {
    let (Some(carried), AgentInstanceServerMessage::ChannelHistoryReplay { message, .. }) =
        (carried, server_msg)
    else {
        return false;
    };
    message.channel_id == carried.channel_id
        && message
            .sequence
            .is_some_and(|sequence| sequence <= carried.through_sequence)
}

#[cfg(test)]
pub(crate) mod tests {
    use crate::agent_instance_connection::tests::trace_test_agent;
    use crate::protocol::{AgentInstanceServerMessage, ChannelMessage, MessageSender};

    use super::{
        PromptCarriedHistory, RegisteredAuthor, delivery_is_acknowledged_and_dropped,
        delivery_is_context_only, delivery_is_own_cross_channel_reply,
        delivery_is_spawn_summon_echo, delivery_was_carried_by_prompt, join_after_sequence,
        live_channel_delivery_is_own_echo, registered_author_from,
    };

    fn live_channel_message_from(
        kind: &str,
        identity_id: Option<&str>,
    ) -> AgentInstanceServerMessage {
        live_channel_message_from_instance(kind, identity_id, Some("instance-1"))
    }

    /// Which Instance authored a test message. Agent senders always name one;
    /// `None` is the pre-rule history shape.
    fn sent_by_instance(message: ChannelMessage, instance_id: Option<&str>) -> ChannelMessage {
        ChannelMessage {
            from: MessageSender {
                instance_id: instance_id.map(str::to_string),
                ..message.from
            },
            ..message
        }
    }

    fn live_channel_message_from_instance(
        kind: &str,
        identity_id: Option<&str>,
        instance_id: Option<&str>,
    ) -> AgentInstanceServerMessage {
        AgentInstanceServerMessage::ChannelMessageReceived {
            message: sent_by_instance(
                test_channel_message(
                    "msg-1",
                    Some(3),
                    kind,
                    identity_id,
                    "hello",
                    "2026-08-04T00:00:00Z",
                ),
                instance_id,
            ),
            client_message_id: None,
            ack_required: Some(true),
            interrupt_requested: Some(true),
            delivery_intent: None,
        }
    }

    /// One replay frame built in one place, so an intent test cannot drift
    /// from the frame declaration it is supposed to be exercising.
    pub(crate) fn replay_frame(
        message: ChannelMessage,
        delivery_intent: Option<&str>,
    ) -> AgentInstanceServerMessage {
        AgentInstanceServerMessage::ChannelHistoryReplay {
            message,
            ack_required: Some(true),
            delivery_intent: delivery_intent.map(str::to_string),
        }
    }

    /// One message built in one place, so a frame test cannot drift from the
    /// declaration it is supposed to be exercising.
    pub(crate) fn test_channel_message(
        message_id: &str,
        sequence: Option<u64>,
        kind: &str,
        identity_id: Option<&str>,
        body: &str,
        sent_at: &str,
    ) -> ChannelMessage {
        crate::channel_fixtures::message(
            message_id,
            "ch-1",
            sequence,
            crate::channel_fixtures::sender(
                identity_id,
                kind,
                "sender",
                "user-1",
                "sender@example.com",
            ),
            body,
            sent_at,
        )
    }

    fn registered_author(identity_id: &str, instance_id: &str) -> RegisteredAuthor {
        RegisteredAuthor {
            identity_id: identity_id.into(),
            instance_id: instance_id.into(),
        }
    }

    #[test]
    fn own_live_echo_is_detected_only_for_the_registered_agent_instance() {
        let me = registered_author("agent:1", "instance-1");
        let own = live_channel_message_from("agent", Some("agent:1"));
        assert!(live_channel_delivery_is_own_echo(&own, Some(&me)));
        // A different agent, a human sender, and a sender without an identity
        // are all real deliveries.
        let peer = live_channel_message_from("agent", Some("agent:2"));
        assert!(!live_channel_delivery_is_own_echo(&peer, Some(&me)));
        let human = live_channel_message_from("user", Some("agent:1"));
        assert!(!live_channel_delivery_is_own_echo(&human, Some(&me)));
        let anonymous = live_channel_message_from("agent", None);
        assert!(!live_channel_delivery_is_own_echo(&anonymous, Some(&me)));
        // Before registration confirms an author nothing is filtered.
        assert!(!live_channel_delivery_is_own_echo(&own, None));
    }

    /// Production, 2026-09-30: `claude:6` replied to its own link in a thread
    /// and the relay into its birth Channel came back to it, first live
    /// (interrupting its turn), then as catch-up after a restart. Its
    /// registration-confirmed id need not equal the relay's Agent id.
    #[test]
    fn a_relayed_reply_to_its_own_link_is_dropped_live_and_on_catch_up() {
        let me = registered_author("registration-agent-7", "chan-1:6");
        let relay_message = |instance: &str, kind: &str| {
            let mut message = test_channel_message(
                "link-reply:r-1",
                Some(9),
                "user",
                Some("user:owner-1"),
                "hi",
                "2026-09-30T20:26:42Z",
            );
            message.metadata = Some(serde_json::json!({
                "xmatrixProvenance": "cross_channel_reply",
                "crossChannelReply": {
                    "sourceChannelId": "chan-2", "sourceMessageId": "r-1", "linkMessageId": "l-1",
                    "replierKind": kind, "replierAgentId": instance, "replierInstanceId": instance,
                },
            }));
            message
        };
        let live =
            |instance: &str, kind: &str| AgentInstanceServerMessage::ChannelMessageReceived {
                message: relay_message(instance, kind),
                client_message_id: None,
                ack_required: Some(true),
                interrupt_requested: Some(true),
                delivery_intent: None,
            };
        assert!(delivery_is_acknowledged_and_dropped(
            &live("chan-1:6", "agent"),
            Some(&me),
            None
        ));
        assert!(delivery_is_acknowledged_and_dropped(
            &replay_frame(relay_message("chan-1:6", "agent"), None),
            Some(&me),
            None
        ));
        // Another Instance's reply, or a person's, is work for this Instance.
        assert!(!delivery_is_own_cross_channel_reply(
            &live("chan-1:7", "agent"),
            Some(&me)
        ));
        assert!(!delivery_is_own_cross_channel_reply(
            &live("chan-1:6", "user"),
            Some(&me)
        ));
        assert!(!delivery_is_own_cross_channel_reply(
            &live("chan-1:6", "agent"),
            None
        ));
    }

    /// The regression this filter existed to cause: one Agent, two live
    /// Instances. They share the profile identity and are separate
    /// participants, so each must hear the other rather than read it as itself.
    #[test]
    fn a_sibling_instance_of_the_same_agent_is_a_real_delivery() {
        let me = registered_author("agent:1", "instance-1");
        let sibling =
            live_channel_message_from_instance("agent", Some("agent:1"), Some("instance-2"));
        assert!(!live_channel_delivery_is_own_echo(&sibling, Some(&me)));
        assert!(!delivery_is_acknowledged_and_dropped(
            &sibling,
            Some(&me),
            None
        ));
        // And the instance's own echo is still suppressed, which is the whole
        // reason the filter exists: it must not cancel its own active turn.
        let mine = live_channel_message_from_instance("agent", Some("agent:1"), Some("instance-1"));
        assert!(delivery_is_acknowledged_and_dropped(&mine, Some(&me), None));
    }

    /// A Channel-summoned Instance registers as `<channel>:<N>`, and the hub
    /// presents its messages as `agent:<channel>:<N>`. That is still its echo.
    #[test]
    fn own_echo_is_detected_through_the_agent_prefixed_presentation() {
        let me = registered_author("chan-1:1", "chan-1:1");
        let own =
            live_channel_message_from_instance("agent", Some("agent:chan-1:1"), Some("chan-1:1"));
        assert!(live_channel_delivery_is_own_echo(&own, Some(&me)));
        let other_agent =
            live_channel_message_from_instance("agent", Some("agent:chan-1:2"), Some("chan-1:1"));
        assert!(!live_channel_delivery_is_own_echo(&other_agent, Some(&me)));
        let sibling =
            live_channel_message_from_instance("agent", Some("agent:chan-1:1"), Some("chan-1:2"));
        assert!(!live_channel_delivery_is_own_echo(&sibling, Some(&me)));
    }

    /// An Agent message that names no Instance is not this Instance's echo. The
    /// hub refuses to commit one, so this is a message from before that rule —
    /// history, not something to suppress.
    #[test]
    fn an_agent_message_without_an_instance_is_never_my_echo() {
        let me = registered_author("agent:1", "instance-1");
        let legacy = live_channel_message_from_instance("agent", Some("agent:1"), None);
        assert!(!live_channel_delivery_is_own_echo(&legacy, Some(&me)));
    }

    #[test]
    fn an_author_is_registered_only_with_its_instance() {
        let mut agent = trace_test_agent("instance-1");
        assert_eq!(
            registered_author_from(&agent),
            Some(registered_author("agent:1", "instance-1"))
        );
        agent.instance_id = Some("   ".into());
        assert_eq!(registered_author_from(&agent), None);
        agent.instance_id = None;
        assert_eq!(registered_author_from(&agent), None);
    }

    #[test]
    fn the_summoning_message_is_filtered_only_for_the_spawned_run() {
        let summon = live_channel_message_from("user", Some("user:1"));
        // The daemon spawned this run from msg-1, whose text is already the
        // initial prompt: acknowledge and drop it instead of replaying the task.
        assert!(delivery_is_spawn_summon_echo(&summon, Some("msg-1")));
        // Every later message in the same channel is real work.
        let mut follow_up = live_channel_message_from("user", Some("user:1"));
        if let AgentInstanceServerMessage::ChannelMessageReceived { message, .. } = &mut follow_up {
            message.message_id = "msg-2".into();
        }
        assert!(!delivery_is_spawn_summon_echo(&follow_up, Some("msg-1")));
        // Interactive runs carry no spawn message and filter nothing.
        assert!(!delivery_is_spawn_summon_echo(&summon, None));
    }

    /// The frame the guard has to catch. A summon commits before the instance
    /// it spawns connects, so it only ever arrives as connect-time catch-up;
    /// matching live delivery alone left the run re-executing its own summon.
    #[test]
    fn the_summon_replayed_as_catch_up_history_is_filtered_too() {
        let replayed_summon = replay_frame(
            test_channel_message(
                "msg-1",
                Some(3),
                "user",
                Some("user:1"),
                "@agent:new fix the thing",
                "2026-08-04T00:00:00Z",
            ),
            None,
        );
        assert!(delivery_is_spawn_summon_echo(
            &replayed_summon,
            Some("msg-1")
        ));
    }

    /// Channel 9806a6a6: the first prompt carried #1-#1405, yet the join
    /// offered no floor, so the hub caught up from a predecessor's cursor at
    /// #1385 and an old `/kill all`, a stop and two summons came back as work.
    #[test]
    fn the_join_offers_the_first_prompt_read_as_its_catch_up_floor() {
        let carried = PromptCarriedHistory {
            channel_id: "ch-1".into(),
            through_sequence: 1405,
        };
        assert_eq!(join_after_sequence("ch-1", Some(&carried)), Some(1405));
        assert_eq!(join_after_sequence("ch-2", Some(&carried)), None);
        assert_eq!(join_after_sequence("ch-1", None), None);
    }

    #[test]
    fn catch_up_the_first_prompt_already_carried_is_not_work() {
        let carried = PromptCarriedHistory {
            channel_id: "ch-1".into(),
            through_sequence: 23,
        };
        let replay = |sequence| {
            replay_frame(
                test_channel_message(
                    "msg-17",
                    Some(sequence),
                    "user",
                    Some("user:1"),
                    "/kill all",
                    "2026-08-04T00:00:00Z",
                ),
                None,
            )
        };
        assert!(delivery_was_carried_by_prompt(&replay(17), Some(&carried)));
        assert!(delivery_was_carried_by_prompt(&replay(23), Some(&carried)));
        // Anything after the read is new work, as is every run without a read.
        assert!(!delivery_was_carried_by_prompt(&replay(24), Some(&carried)));
        assert!(!delivery_was_carried_by_prompt(&replay(17), None));
        // Another channel's sequences say nothing about this read.
        let other = PromptCarriedHistory {
            channel_id: "ch-2".into(),
            through_sequence: 23,
        };
        assert!(!delivery_was_carried_by_prompt(&replay(17), Some(&other)));
        // Live delivery is never backlog.
        let mut live = live_channel_message_from("user", Some("user:1"));
        if let AgentInstanceServerMessage::ChannelMessageReceived { message, .. } = &mut live {
            message.sequence = Some(17);
        }
        assert!(!delivery_was_carried_by_prompt(&live, Some(&carried)));
    }

    /// Orientation is acknowledged and skipped; work is executed. The hub is
    /// what knows which is which, so an unlabelled delivery stays work — a hub
    /// that predates the field must not have its backlog silently dropped.
    #[test]
    fn context_deliveries_are_recognized_and_an_unlabelled_one_stays_work() {
        let notice = test_channel_message(
            "system:msg-1:9f2a",
            Some(4),
            "user",
            Some("user:1"),
            "xMatrix queued @agent for repo.",
            "2026-08-04T00:00:01Z",
        );
        assert!(delivery_is_context_only(&replay_frame(
            notice.clone(),
            Some("context")
        )));
        assert!(!delivery_is_context_only(&replay_frame(
            notice.clone(),
            Some("work")
        )));
        assert!(!delivery_is_context_only(&replay_frame(notice, None)));

        // The join window arrives as context too, and a live message the hub
        // marks as a system fact is context even though it is not a replay.
        let live_notice = AgentInstanceServerMessage::ChannelMessageReceived {
            message: test_channel_message(
                "system:msg-2:1b7c",
                Some(5),
                "user",
                Some("user:1"),
                "xMatrix could not start @other.",
                "2026-08-04T00:00:02Z",
            ),
            client_message_id: None,
            ack_required: Some(true),
            interrupt_requested: Some(true),
            delivery_intent: Some("context".into()),
        };
        assert!(delivery_is_context_only(&live_notice));
    }

    /// The runtime interrupts a running turn for any delivery that gets past
    /// this connection, so what this drops is the whole guard against a join
    /// window cancelling real work. Pinned here because the runtime has no way
    /// to tell the difference: catch-up carries no interrupt flag to weigh.
    #[test]
    fn only_orientation_is_dropped_before_the_runtime_sees_a_delivery() {
        let peer = test_channel_message(
            "msg-1",
            Some(1),
            "agent",
            Some("agent:2"),
            "peer work",
            "2026-08-17T00:00:01Z",
        );

        // Catch-up work reaches the runtime, which is what makes it
        // interruptible rather than something that waits out the turn.
        assert!(!delivery_is_acknowledged_and_dropped(
            &replay_frame(peer.clone(), None),
            Some(&registered_author("agent:1", "instance-1")),
            None,
        ));
        assert!(!delivery_is_acknowledged_and_dropped(
            &replay_frame(peer.clone(), Some("work")),
            Some(&registered_author("agent:1", "instance-1")),
            None,
        ));

        // Orientation never does.
        assert!(delivery_is_acknowledged_and_dropped(
            &replay_frame(peer, Some("context")),
            Some(&registered_author("agent:1", "instance-1")),
            None,
        ));

        // This instance's own message is dropped from live delivery but kept in
        // replay, where it is legitimate context rather than work. The runtime
        // is what must not interrupt on it, since only the runtime knows a turn
        // is running; see `event_requests_active_turn_interrupt`.
        let own = sent_by_instance(
            test_channel_message(
                "msg-2",
                Some(2),
                "agent",
                Some("agent:1"),
                "my own send",
                "2026-08-17T00:00:02Z",
            ),
            Some("instance-1"),
        );
        assert!(!delivery_is_acknowledged_and_dropped(
            &replay_frame(own.clone(), None),
            Some(&registered_author("agent:1", "instance-1")),
            None,
        ));
        assert!(delivery_is_acknowledged_and_dropped(
            &AgentInstanceServerMessage::ChannelMessageReceived {
                message: own,
                client_message_id: None,
                ack_required: Some(true),
                interrupt_requested: Some(true),
                delivery_intent: None,
            },
            Some(&registered_author("agent:1", "instance-1")),
            None,
        ));

        // Nor the summoning message, already delivered as the initial prompt.
        let summon = test_channel_message(
            "msg-3",
            Some(3),
            "user",
            Some("user:1"),
            "@agent do the thing",
            "2026-08-17T00:00:03Z",
        );
        assert!(delivery_is_acknowledged_and_dropped(
            &replay_frame(summon, None),
            Some(&registered_author("agent:1", "instance-1")),
            Some("msg-3"),
        ));
    }

    #[test]
    fn own_history_replay_is_not_treated_as_an_echo() {
        let replay = replay_frame(
            test_channel_message(
                "msg-2",
                Some(4),
                "agent",
                Some("agent:1"),
                "replayed",
                "2026-08-04T00:00:00Z",
            ),
            None,
        );
        assert!(!live_channel_delivery_is_own_echo(
            &replay,
            Some(&registered_author("agent:1", "instance-1"))
        ));
    }
}
