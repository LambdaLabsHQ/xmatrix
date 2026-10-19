// The input side shared by the channel-driven vendor run loops. Model and
// effort switch requests and parameter controls are answered here, so a loop
// only sees the channel batches it turns into prompts and the connection
// events it handles itself.

use std::collections::VecDeque;
use std::future::Future;

use tokio::sync::mpsc;
use tokio::sync::mpsc::error::TryRecvError;

use crate::harness_parameters::ParameterCommand;
use crate::{
    InboundChannelMessage, PresencePatch, TerminationSignals, ack_inbound_channel_messages,
    agent_instance_connection, emit_agent_connection_reconnected_lifecycle,
    is_channel_delivery_connection_event, next_agent_event_or_termination, next_channel_delivery,
    protocol, send_presence,
};

type ConnectionEvent = agent_instance_connection::AgentInstanceConnectionEvent;
use xmatrix_cli_core::page_co_write::PageCoWriteEvent;

/// A runtime whose model, effort and harness parameters the channel controls.
pub(crate) trait ChannelControlledRuntime {
    /// Switch to the requested model, answering with what was selected.
    async fn request_model_switch(&mut self, requested: &str) -> Result<String, String>;

    /// Switch to the requested reasoning effort, answering with what was selected.
    async fn request_effort_switch(&mut self, requested: &str) -> Result<String, String>;

    /// The presence an accepted switch reports.
    fn switch_presence(&self) -> PresencePatch;

    /// Apply or report the harness parameter a control message names.
    async fn parameter_control(
        &mut self,
        command: ParameterCommand,
        message: &InboundChannelMessage,
        agent: &protocol::SerializedAgent,
    ) -> Result<String, String>;

    /// The presence reported once a parameter control is answered.
    fn parameter_presence(&self) -> PresencePatch;

    /// The harness parameters as the session holds them now.
    fn parameter_catalog(&self) -> Vec<protocol::HarnessParameter>;

    /// A local selection still awaiting provider confirmation.
    fn pending_parameter_selection(&self, _id: &str) -> Option<String> {
        None
    }
}

/// What a vendor run loop acts on next.
pub(crate) enum RunLoopInput {
    /// A channel batch for the runtime to turn into a prompt.
    Delivery {
        channel_id: String,
        messages: Vec<InboundChannelMessage>,
        /// The slash command a lone addressed message carries, if any.
        passthrough: Option<String>,
    },
    /// A model or effort switch cancelled the turn running in `channel_id`
    /// and nothing newer is waiting: the loop resumes that work with `prompt`
    /// in the same session, on the new selection.
    Resume { channel_id: String, prompt: String },
    /// A connection event the loop handles itself.
    Event(Box<ConnectionEvent>),
}

/// The input a resumed turn starts from.
///
/// Every harness needs some input to start inference, and the turn it resumes
/// ends on the harness's own record of the cancellation — Claude, for one,
/// writes the cancelled tool call as "the user doesn't want to proceed" —
/// which a model otherwise reads as a person rejecting its work and stops. So
/// the input says who cancelled it and why, and nothing else.
pub(crate) fn switch_resume_prompt(selections: &[String]) -> String {
    let cause = if selections.is_empty() {
        "for a model or effort switch, which was not applied".to_string()
    } else {
        format!(
            "so that the switch to {} took effect at once",
            selections.join(" and ")
        )
    };
    format!(
        "[xMatrix] xMatrix interrupted your previous turn {cause}; no person interrupted or \
rejected anything. A tool call cancelled by that interrupt may have partly run: check its side \
effects before retrying it. Continue the interrupted work from where it stopped. If it was \
already complete, end the turn without doing anything more."
    )
}

/// The connection events a run loop reads, with those queued while a turn ran.
pub(crate) struct RunLoopEvents<'a> {
    pub(crate) rx: mpsc::UnboundedReceiver<ConnectionEvent>,
    pub(crate) pending: VecDeque<ConnectionEvent>,
    relay: &'a agent_instance_connection::AgentInstanceConnectionClient,
    auto_join_channel_id: Option<&'a str>,
    agent: &'a protocol::SerializedAgent,
    watch_termination: bool,
    termination_signals: Option<TerminationSignals>,
    /// The channel whose last turn ended cancelled, until something answers it.
    interrupted_turn: Option<String>,
    /// A resume owed to `interrupted_turn` once a switch landed, with what was
    /// selected. Only for a Hub that does not decide continuations.
    owed_resume: Option<(String, Vec<String>)>,
    /// The turn a switch cancelled, by channel and the switches since, while
    /// this loop waits for the Hub's continuation instruction.
    awaiting_continuation: Option<(String, Vec<String>)>,
}

impl<'a> RunLoopEvents<'a> {
    /// Events for a loop that also ends on SIGTERM, SIGHUP or Ctrl-C. The
    /// signals are taken over only once the loop first waits for input.
    pub(crate) fn new(
        rx: mpsc::UnboundedReceiver<ConnectionEvent>,
        relay: &'a agent_instance_connection::AgentInstanceConnectionClient,
        auto_join_channel_id: Option<&'a str>,
        agent: &'a protocol::SerializedAgent,
    ) -> Self {
        Self {
            rx,
            pending: VecDeque::new(),
            relay,
            auto_join_channel_id,
            agent,
            watch_termination: true,
            termination_signals: None,
            interrupted_turn: None,
            owed_resume: None,
            awaiting_continuation: None,
        }
    }

    /// Events for a loop that leaves process signals to their default handling.
    pub(crate) fn without_termination(self) -> Self {
        Self {
            watch_termination: false,
            ..self
        }
    }

    /// Record how the loop's last turn in `channel_id` ended. Only a cancelled
    /// turn can be resumed after a switch; any other outcome settles it.
    pub(crate) fn turn_ended(&mut self, channel_id: &str, interrupted: bool) {
        self.interrupted_turn = interrupted.then(|| channel_id.to_string());
    }

    /// The resume owed after a switch, once no other event is waiting. Waiting
    /// events go first: a newer message is the next turn by itself, and a
    /// switch already queued behind this one should land before the work
    /// resumes rather than cancel the resumed turn again.
    fn take_ready_resume(&mut self) -> Option<RunLoopInput> {
        self.owed_resume.as_ref()?;
        if self.pending.is_empty() {
            match self.rx.try_recv() {
                Ok(event) => self.pending.push_back(event),
                Err(TryRecvError::Empty) => {}
                Err(TryRecvError::Disconnected) => return None,
            }
        }
        if !self.pending.is_empty() {
            return None;
        }
        let (channel_id, selections) = self.owed_resume.take()?;
        Some(RunLoopInput::Resume {
            channel_id,
            prompt: switch_resume_prompt(&selections),
        })
    }

    /// The Hub's instruction to continue a turn a switch cancelled, when
    /// `event` is one for this Instance. It runs only while this loop still
    /// owes that turn (one of its switches is named) and no newer input waits;
    /// otherwise it is acknowledged and dropped. `None` for any other event.
    fn continuation(&mut self, event: &ConnectionEvent) -> Option<Option<RunLoopInput>> {
        let ConnectionEvent::Server(
            protocol::AgentInstanceServerMessage::ChannelMessageReceived { message, .. }
            | protocol::AgentInstanceServerMessage::ChannelHistoryReplay { message, .. },
        ) = event
        else {
            return None;
        };
        let instruction = protocol::channel_switch_continuation(message)?;
        if self.agent.instance_id.as_deref() != Some(instruction.instance_id.as_str()) {
            return None;
        }
        let _ = self.relay.ack_channel_message(
            message.message_id.clone(),
            message.channel_id.clone(),
            message.sequence,
        );
        let owed = self.awaiting_continuation.as_ref().is_some_and(|(channel_id, switches)| {
            channel_id == &message.channel_id
                && switches.iter().any(|id| instruction.request_ids.contains(id))
        });
        let superseded = self.pending.iter().any(is_channel_delivery_connection_event);
        if !owed || superseded {
            return Some(None);
        }
        self.awaiting_continuation = None;
        Some(Some(RunLoopInput::Resume {
            channel_id: message.channel_id.clone(),
            prompt: message.body.clone(),
        }))
    }

    /// The Hub's instruction that this conversation co-write a page, or stop:
    /// acknowledged and acted on here; it is no turn. Whether `event` was one.
    fn page_co_write(&mut self, event: &ConnectionEvent) -> bool {
        let ConnectionEvent::Server(
            protocol::AgentInstanceServerMessage::ChannelMessageReceived { message, .. }
            | protocol::AgentInstanceServerMessage::ChannelHistoryReplay { message, .. },
        ) = event
        else {
            return false;
        };
        let Some(instruction) = protocol::channel_page_co_write(message) else {
            return false;
        };
        let _ = self.relay.ack_channel_message(
            message.message_id.clone(),
            message.channel_id.clone(),
            message.sequence,
        );
        crate::runtime_page_co_write::follow(self.relay, &message.channel_id, &instruction);
        true
    }

    async fn next_event(&mut self) -> Option<ConnectionEvent> {
        if self.watch_termination {
            let signals = self
                .termination_signals
                .get_or_insert_with(TerminationSignals::new);
            return next_agent_event_or_termination(signals, &mut self.pending, &mut self.rx).await;
        }
        match self.pending.pop_front() {
            Some(event) => Some(event),
            None => self.rx.recv().await,
        }
    }

    /// The next input for the loop, or `None` once the event stream closes or
    /// the process is asked to stop. Switch requests and parameter controls are
    /// answered on the way.
    pub(crate) async fn next_input<R: ChannelControlledRuntime>(
        &mut self,
        runtime: &mut R,
    ) -> Option<RunLoopInput> {
        let (relay, agent) = (self.relay, self.agent);
        loop {
            if let Some(resume) = self.take_ready_resume() {
                return Some(resume);
            }
            let event = match self.next_event().await? {
                // The page this conversation co-writes asks for the Agent's next turn: it runs
                // as a resume of that conversation, whatever the harness. An interrupt that
                // arrives with no turn running has nothing to stop.
                ConnectionEvent::PageCoWrite(PageCoWriteEvent::Turn {
                    channel_id,
                    turn,
                    prompt,
                }) => {
                    // The page asked again while other work ran: only its newest ask is
                    // answered, since each one says how the page is now.
                    if self.pending.iter().any(|event| {
                        matches!(event, ConnectionEvent::PageCoWrite(PageCoWriteEvent::Turn {
                            channel_id: newer, ..
                        }) if *newer == channel_id)
                    }) {
                        continue;
                    }
                    crate::runtime_page_co_write::turn_queued(&channel_id, turn);
                    return Some(RunLoopInput::Resume { channel_id, prompt });
                }
                ConnectionEvent::PageCoWrite(PageCoWriteEvent::Interrupt { .. }) => continue,
                // What the Agent wrote into a page from this conversation did not all reach it:
                // it hears why, as the conversation's next turn.
                ConnectionEvent::PageCoWrite(PageCoWriteEvent::Outcome { channel_id, prompt }) => {
                    return Some(RunLoopInput::Resume { channel_id, prompt });
                }
                event => event,
            };
            if self.page_co_write(&event) {
                continue;
            }
            let interrupted = self.interrupted_turn.is_some();
            let event = match answer_switch_request(relay, runtime, event, interrupted).await {
                SwitchAnswer::NotASwitch(event) => *event,
                // The Hub decides whether the cancelled turn continues and
                // words its input; this loop waits for that instruction.
                SwitchAnswer::Switched { request_id, .. }
                    if relay.hub_accepts(SWITCH_CONTINUATION) =>
                {
                    if let Some(channel_id) = self.interrupted_turn.take() {
                        self.awaiting_continuation = Some((channel_id, vec![request_id]));
                    } else if let Some((_, switches)) = self.awaiting_continuation.as_mut() {
                        switches.push(request_id);
                    }
                    continue;
                }
                // A refused switch cancelled the turn all the same, so the
                // work resumes either way, on whatever is selected now.
                SwitchAnswer::Switched { selection, .. } => {
                    if let Some(channel_id) = self.interrupted_turn.take() {
                        self.owed_resume = Some((channel_id, Vec::new()));
                    }
                    if let (Some((_, selections)), Some(selection)) =
                        (self.owed_resume.as_mut(), selection)
                    {
                        selections.push(selection);
                    }
                    continue;
                }
            };
            if let Some(continuation) = self.continuation(&event) {
                match continuation {
                    Some(resume) => return Some(resume),
                    None => continue,
                }
            }
            if !is_channel_delivery_connection_event(&event) {
                return Some(RunLoopInput::Event(Box::new(event)));
            }
            let Some((channel_id, messages)) = next_channel_delivery(
                event,
                self.auto_join_channel_id,
                agent,
                &mut self.rx,
                &mut self.pending,
            )
            .await
            else {
                continue;
            };
            if let Some(command) = crate::single_message_parameter_control(&messages, agent) {
                let requested = command.clone();
                let outcome = runtime
                    .parameter_control(command, &messages[0], agent)
                    .await;
                ack_inbound_channel_messages(relay, &messages);
                send_presence(relay, Some("idle"), runtime.parameter_presence());
                crate::harness_parameters::report_parameter_control(
                    relay,
                    &channel_id,
                    &messages[0].message_id,
                    &requested,
                    &runtime.parameter_catalog(),
                    requested.as_ref().ok().and_then(|(id, _)| runtime.pending_parameter_selection(id)),
                    outcome,
                )
                .await;
                continue;
            }
            let passthrough = crate::single_message_slash_passthrough(&messages, agent);
            // The newer message is the next turn; the cancelled one is not
            // resumed behind it.
            self.interrupted_turn = None;
            self.owed_resume = None;
            self.awaiting_continuation = None;
            return Some(RunLoopInput::Delivery {
                channel_id,
                messages,
                passthrough,
            });
        }
    }
}

enum SwitchAnswer {
    NotASwitch(Box<ConnectionEvent>),
    /// A switch was answered; carries what it selected, e.g. "model `x`",
    /// or nothing when it was refused, and the request it answered.
    Switched {
        selection: Option<String>,
        request_id: String,
    },
}

/// The Hub capability that decides and words a switch's continuation.
const SWITCH_CONTINUATION: &str = "switch_continuation";

/// Answer a model or effort switch request; any other event is handed back.
///
/// Each runtime resolves the selection its own way and updates its own
/// presentation state, but what follows an accepted switch is one fact for all
/// of them: record the selection, report `idle` with the presence the switch
/// produced, then answer the request.
async fn answer_switch_request<R: ChannelControlledRuntime>(
    relay: &agent_instance_connection::AgentInstanceConnectionClient,
    runtime: &mut R,
    event: ConnectionEvent,
    interrupted_turn: bool,
) -> SwitchAnswer {
    let (is_model, request_id, outcome) = match event {
        ConnectionEvent::Server(
            protocol::AgentInstanceServerMessage::AgentModelSwitchRequested { request_id, model },
        ) => (true, request_id, runtime.request_model_switch(&model).await),
        ConnectionEvent::Server(
            protocol::AgentInstanceServerMessage::AgentEffortSwitchRequested { request_id, effort },
        ) => (
            false,
            request_id,
            runtime.request_effort_switch(&effort).await,
        ),
        event => return SwitchAnswer::NotASwitch(Box::new(event)),
    };
    let (selected, error) = match outcome {
        Ok(selected) => {
            let status = if is_model {
                "model_selected"
            } else {
                "effort_selected"
            };
            crate::write_current_run_status(status, false, Some(&selected));
            send_presence(relay, Some("idle"), runtime.switch_presence());
            (Some(selected), None)
        }
        Err(error) => (None, Some(error)),
    };
    let answer = SwitchAnswer::Switched {
        selection: selected
            .as_ref()
            .map(|selected| format!("{} `{selected}`", if is_model { "model" } else { "effort" })),
        request_id: request_id.clone(),
    };
    let interrupted_turn = interrupted_turn.then_some(true);
    let _ = relay.send_message(if is_model {
        protocol::AgentInstanceClientMessage::AgentModelSwitchResult {
            request_id,
            model: selected,
            error,
            interrupted_turn,
        }
    } else {
        protocol::AgentInstanceClientMessage::AgentEffortSwitchResult {
            request_id,
            effort: selected,
            error,
            interrupted_turn,
        }
    });
    answer
}

/// Await a turn while relay events keep arriving. Each event goes to
/// `on_event` first, which may act on it at once (interrupting the turn, say);
/// unless it reports the event consumed, the event stays queued for the run
/// loop.
pub(crate) async fn await_turn_with_events<T>(
    turn: impl Future<Output = T>,
    event_rx: &mut mpsc::UnboundedReceiver<ConnectionEvent>,
    pending_events: &mut VecDeque<ConnectionEvent>,
    mut on_event: impl AsyncFnMut(&ConnectionEvent) -> bool,
) -> T {
    tokio::pin!(turn);
    let mut relay_events_open = true;
    loop {
        tokio::select! {
            biased;
            result = &mut turn => return result,
            event = event_rx.recv(), if relay_events_open => match event {
                Some(event) => {
                    if !on_event(&event).await {
                        pending_events.push_back(event);
                    }
                }
                None => relay_events_open = false,
            },
        }
    }
}

/// Re-registration resets the Hub's in-memory status to online, so a turn
/// whose connection comes back re-asserts `busy` once at that boundary;
/// unchanged state must not generate periodic presence traffic. Returns
/// whether `event` was that reconnect.
pub(crate) fn reassert_busy_on_reconnect(
    event: &ConnectionEvent,
    relay: Option<&agent_instance_connection::AgentInstanceConnectionClient>,
    channel_id: Option<&str>,
    busy: impl FnOnce() -> PresencePatch,
) -> bool {
    let ConnectionEvent::Reconnected {
        agent: reconnected_agent,
        ..
    } = event
    else {
        return false;
    };
    if let Some(relay) = relay {
        emit_agent_connection_reconnected_lifecycle(relay, channel_id, reconnected_agent);
        send_presence(relay, Some("busy"), busy());
    }
    true
}
