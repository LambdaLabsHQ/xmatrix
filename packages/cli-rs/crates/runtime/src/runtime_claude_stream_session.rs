// The streaming session state: the live model, the turn in flight, and the
// interrupter that can cut it short.

use colored::Colorize;
/// How long the persistent Claude process may emit nothing on stdout while a
/// turn is in flight before the watchdog treats it as hung and forces recovery.
/// Generous on purpose: Claude streams frequently while working, so prolonged
/// total silence during an active turn almost always means a stuck process, but
/// we don't want to kill a legitimately long tool run.
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;

use serde_json::Value;
use tokio::process::Child;
use tokio::process::ChildStdin;
use tokio::sync::Mutex as AsyncMutex;

use crate::agent_presentation::{
    AgentPresentationSnapshot, agent_commands_for_runtime_with_overlay, models_support_efforts,
    resolve_switchable_model,
};
use crate::model_catalog_presentation_with_commands;
use crate::runtime_agent_goal_status::ClaudeTranscriptWatcher;
use crate::runtime_claude_stream_io::{
    ClaudeSessionState, ClaudeStreamLaunch, ClaudeStreamShared, start_claude_stream_process,
    write_claude_control_line,
};
use crate::runtime_claude_turn::claude_apply_effort_control_request;
use crate::runtime_claude_turn::claude_effort_catalog;
use crate::runtime_claude_turn::claude_initial_effort_from_args;
use crate::runtime_claude_turn::claude_initial_model_from_args;
use crate::runtime_claude_turn::claude_interrupt_control_request;
use crate::runtime_claude_turn::claude_model_catalog;
use crate::runtime_claude_turn::claude_permission_response;
use crate::runtime_claude_turn::claude_reborn_resume_refusal;
use crate::runtime_claude_turn::claude_set_model_control_request;
use crate::runtime_claude_turn::clear_claude_resume_session_id;
use crate::runtime_claude_turn::exit_status_signal_terminated;
use crate::runtime_claude_turn::load_claude_resume_session_id;
use crate::runtime_harness_questions::{
    PendingQuestions, QuestionnaireReply, claude_answered_input,
};
use crate::runtime_trusted_role_prompt::claude_stream_user_message;
use crate::runtime_usage_limit::UsageLimit;
use crate::{
    CliError, agent_instance_connection, error, merge_llm_usage, process_tree, protocol,
    write_current_run_effort, write_current_run_model, write_json_line,
};

pub(crate) const CLAUDE_STREAM_IDLE_LIMIT: Duration = Duration::from_secs(900);

pub(crate) const CLAUDE_STREAM_WATCHDOG_TICK: Duration = Duration::from_secs(30);

/// After the stdout-idle limit trips, ask the process itself before assuming a
/// hang. Any stdout response proves liveness and resets `last_activity`.
pub(crate) const CLAUDE_STREAM_PROBE_GRACE: Duration = Duration::from_secs(60);

/// How often the watchdog looks, how much stdout silence it tolerates during a
/// turn, how long the liveness probe gets to answer, and how long a tool call
/// runs before it is a wait (docs/design/agent-status.md). Tests shrink these.
#[derive(Clone, Copy, Debug)]
pub(crate) struct ClaudeWatchdogTimings {
    pub(crate) tick: Duration,
    pub(crate) idle_limit: Duration,
    pub(crate) probe_grace: Duration,
    pub(crate) tool_wait: Duration,
}

impl Default for ClaudeWatchdogTimings {
    fn default() -> Self {
        Self {
            tick: CLAUDE_STREAM_WATCHDOG_TICK,
            idle_limit: CLAUDE_STREAM_IDLE_LIMIT,
            probe_grace: CLAUDE_STREAM_PROBE_GRACE,
            tool_wait: crate::runtime_waiting::TOOL_WAIT_THRESHOLD,
        }
    }
}

/// Maximum wait for an interrupt control receipt before reporting that it may
/// have been swallowed.
pub(crate) const CLAUDE_INTERRUPT_RECEIPT_TIMEOUT: Duration = Duration::from_secs(10);

/// How long a switch control request (`set_model`, `apply_flag_settings`) may
/// wait for its `control_response`. Must stay under the hub's 10s
/// `AGENT_INSTANCE_CONTROL_SWITCH_TIMEOUT_MS` so the hub receives a definite
/// result instead of timing out first.
pub(crate) const CLAUDE_CONTROL_SWITCH_TIMEOUT: Duration = Duration::from_secs(8);

/// The switchable session controls — model and reasoning effort — shared
/// between the session, its stdout reader, and the daemon event loop, together
/// with the correlation map every control request answers through.
pub(crate) struct ClaudeSessionControls {
    /// Sticky operator-selected model (a catalog alias). Re-applied via
    /// `--model` on every (re)spawn so crash recovery keeps the selection.
    selected: Mutex<Option<String>>,
    /// Latest model observed on stream events (a resolved id such as
    /// `claude-sonnet-5`), seeded from the launcher args or a switch alias.
    current: Mutex<Option<String>>,
    /// Sticky operator-selected reasoning effort, re-applied via `--effort` on
    /// every (re)spawn for the same reason as the model.
    selected_effort: Mutex<Option<String>>,
    /// The effort in force. Unlike the model this is never *observed*: Claude
    /// reports no effort on any stream event, so this only ever holds what the
    /// launcher pinned or what a switch set, and `None` honestly means "the
    /// account default, which this runtime cannot see".
    current_effort: Mutex<Option<String>>,
    /// In-flight control requests awaiting a `control_response` (`set_model`
    /// switches, `apply_flag_settings` effort changes and `interrupt` receipts
    /// share the same correlation map).
    pending_controls: Mutex<HashMap<String, tokio::sync::oneshot::Sender<Result<(), String>>>>,
    native_parameters: Mutex<crate::claude_parameters::Facts>,
    parameter_request: Mutex<Option<String>>,
    selected_parameters: Mutex<std::collections::BTreeMap<String, String>>,
    /// AskUserQuestion requests parked until their card is answered, by tool
    /// use id.
    pub(crate) questions: PendingQuestions<ClaudeParkedQuestion>,
}

/// The `can_use_tool` request an AskUserQuestion card answers.
pub(crate) struct ClaudeParkedQuestion {
    pub(crate) request_id: String,
    pub(crate) input: Value,
}

impl ClaudeSessionControls {
    pub(crate) fn new(initial: Option<String>, initial_effort: Option<String>) -> Self {
        Self {
            selected: Mutex::new(None),
            current: Mutex::new(initial),
            selected_effort: Mutex::new(None),
            current_effort: Mutex::new(initial_effort),
            pending_controls: Mutex::new(HashMap::new()),
            native_parameters: Mutex::new(crate::claude_parameters::Facts::default()),
            parameter_request: Mutex::new(None),
            selected_parameters: Mutex::new(std::collections::BTreeMap::new()),
            questions: PendingQuestions::default(),
        }
    }

    pub(crate) fn observe_initialize(&self, frame: &Value) -> bool {
        if frame.pointer("/response/subtype").and_then(Value::as_str) != Some("success") {
            return false;
        }
        let expected = self
            .parameter_request
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if expected.is_none()
            || frame
                .pointer("/response/request_id")
                .and_then(Value::as_str)
                != expected.as_deref()
        {
            return false;
        }
        let value = frame.pointer("/response/response").unwrap_or(&Value::Null);
        *self
            .native_parameters
            .lock()
            .unwrap_or_else(|p| p.into_inner()) =
            crate::claude_parameters::initialize_facts(value, self.current().as_deref());
        true
    }

    fn parameter_request_id(&self) -> String {
        let id = format!("xmatrix-parameters-init-{}", uuid::Uuid::new_v4());
        *self
            .parameter_request
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some(id.clone());
        id
    }

    pub(crate) fn parameter_facts(&self) -> crate::claude_parameters::Facts {
        self.native_parameters
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    pub(crate) fn current(&self) -> Option<String> {
        self.current
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone()
    }

    /// Records the latest observed model; returns whether it changed.
    pub(crate) fn set_current(&self, model: &str) -> bool {
        let mut guard = self
            .current
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if guard.as_deref() == Some(model) {
            return false;
        }
        *guard = Some(model.to_string());
        true
    }

    fn selected(&self) -> Option<String> {
        self.selected
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone()
    }

    fn set_selected(&self, model: &str) {
        *self
            .selected
            .lock()
            .unwrap_or_else(|poison| poison.into_inner()) = Some(model.to_string());
    }

    /// The effort in force: the level the newest transcript record says the
    /// model actually ran at, or — until a turn has written one — whatever
    /// pinned it. `None` only while both are unknown, which is the window
    /// between an instance appearing and finishing its first turn.
    pub(crate) fn current_effort(&self) -> Option<String> {
        self.current_effort
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone()
    }

    fn selected_effort(&self) -> Option<String> {
        self.selected_effort
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone()
    }

    /// Records an operator switch: sticky for future spawns, and reported
    /// right away so the chip answers the click. The next transcript read
    /// replaces it with what Claude actually ran at, which is what makes a
    /// switch Claude quietly ignored visible instead of permanent.
    fn set_selected_effort(&self, effort: &str) {
        *self
            .selected_effort
            .lock()
            .unwrap_or_else(|poison| poison.into_inner()) = Some(effort.to_string());
        self.set_current_effort(effort);
    }

    /// Records an observed effort — the counterpart of `set_current` for the
    /// model, down to reporting whether it changed so the run-status marker is
    /// only rewritten when it did. Never sticky: only a switch pins a level
    /// for the next spawn.
    pub(crate) fn set_current_effort(&self, effort: &str) -> bool {
        let mut guard = self
            .current_effort
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if guard.as_deref() == Some(effort) {
            return false;
        }
        *guard = Some(effort.to_string());
        true
    }

    fn register_control(
        &self,
        request_id: String,
        waiter: tokio::sync::oneshot::Sender<Result<(), String>>,
    ) {
        self.pending_controls
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .insert(request_id, waiter);
    }

    pub(crate) fn resolve_control(
        &self,
        request_id: &str,
    ) -> Option<tokio::sync::oneshot::Sender<Result<(), String>>> {
        self.pending_controls
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .remove(request_id)
    }
}

pub(crate) enum ClaudeTurnStatus {
    Completed,
    Failed,
    TransportFailed,
    /// The wrapper interrupted the turn itself (a newer channel message
    /// superseded it) and Claude ended it with an error result. Not a failure:
    /// nothing is reported on the channel as "could not complete".
    Interrupted,
}

impl ClaudeTurnStatus {
    /// The status of a turn that ended with a `result` frame. An error result
    /// after the wrapper asked for an interrupt is that interrupt landing
    /// (Claude 2.1.280 answers it with `error_during_execution`,
    /// `terminal_reason: aborted_streaming`); an error result without one is a
    /// genuine failure, and a success result stays a success even if an
    /// interrupt raced it.
    ///
    /// An exhausted context window is a failure even when an interrupt raced
    /// it: the session is retired, and the channel must learn why.
    pub(crate) fn for_result(
        result_failed: bool,
        interrupt_requested: bool,
        context_exhausted: bool,
    ) -> Self {
        if context_exhausted {
            return Self::Failed;
        }
        match (result_failed, interrupt_requested) {
            (false, _) => Self::Completed,
            (true, true) => Self::Interrupted,
            (true, false) => Self::Failed,
        }
    }
}

pub(crate) struct ClaudeStreamOutcome {
    pub(crate) answer: String,
    pub(crate) usage: Option<protocol::LlmUsage>,
    pub(crate) status: ClaudeTurnStatus,
    /// Claude rejected a request of this turn on a used-up usage window.
    pub(crate) usage_limit: Option<UsageLimit>,
}

#[derive(Clone)]
pub(crate) struct ClaudeStreamInterrupter {
    stdin: Arc<Mutex<Option<Arc<AsyncMutex<ChildStdin>>>>>,
    active: Arc<AsyncMutex<Option<ActiveStreamTurn>>>,
    controls: Arc<ClaudeSessionControls>,
}

impl ClaudeStreamInterrupter {
    /// Answer the AskUserQuestion `reply` is for. False when no such question
    /// is parked (it was cancelled, or the card outlived its turn): the reply
    /// is then an ordinary message.
    pub(crate) async fn answer_question(&self, reply: &QuestionnaireReply) -> bool {
        let Some(parked) = self.controls.questions.take(&reply.request_key) else {
            return false;
        };
        let input = claude_answered_input(&parked.input, &reply.answers);
        write_claude_control_line(
            &self.stdin,
            &claude_permission_response(&parked.request_id, Ok(input)),
        )
        .await
    }

    /// Withdraw every parked question: a message the person typed instead
    /// supersedes them, and Claude must not wait on a card any longer.
    pub(crate) async fn cancel_questions(&self) {
        for parked in self.controls.questions.drain() {
            write_claude_control_line(
                &self.stdin,
                &claude_permission_response(
                    &parked.request_id,
                    Err("The person answered in the channel instead of on the question card; their message follows."),
                ),
            )
            .await;
        }
    }

    pub(crate) async fn interrupt_active_turn(&self) -> error::Result<bool> {
        {
            let mut active = self.active.lock().await;
            let Some(turn) = active.as_mut() else {
                return Ok(false);
            };
            // Marked before the request is written so the result it provokes
            // can never be read as a genuine failure.
            turn.interrupt_requested = true;
        }
        let stdin = self
            .stdin
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone()
            .ok_or_else(|| CliError::Launch("Claude stream stdin unavailable".to_string()))?;
        let request_id = format!("xmatrix-interrupt-{}", uuid::Uuid::new_v4());
        let (waiter_tx, waiter_rx) = tokio::sync::oneshot::channel();
        self.controls
            .register_control(request_id.clone(), waiter_tx);
        let bytes = serde_json::to_vec(&claude_interrupt_control_request(&request_id))?;
        write_json_line(&stdin, bytes, "Claude stream interrupt")
            .await
            .map_err(CliError::Launch)?;
        let controls = self.controls.clone();
        tokio::spawn(async move {
            match tokio::time::timeout(CLAUDE_INTERRUPT_RECEIPT_TIMEOUT, waiter_rx).await {
                Ok(Ok(Ok(()))) => {}
                Ok(Ok(Err(err))) => {
                    eprintln!(
                        "{} Claude rejected the interrupt request: {err}",
                        "⚠".yellow().bold()
                    );
                }
                Ok(Err(_)) => {}
                Err(_) => {
                    let _ = controls.resolve_control(&request_id);
                    eprintln!(
                        "{} Claude did not acknowledge an interrupt within {}s; the process may be unresponsive",
                        "⚠".yellow().bold(),
                        CLAUDE_INTERRUPT_RECEIPT_TIMEOUT.as_secs()
                    );
                }
            }
        });
        Ok(true)
    }
}

/// Shared, per-turn state the reader task fills in and the submitter reads back.
/// Exactly one turn is ever active (strict serialization), so a single `Option`
/// is sufficient. `generation` lets the reader notice a new turn began and
/// reset its per-turn trace accumulator.
#[derive(Default)]
pub(crate) struct ActiveStreamTurn {
    pub(crate) channel_id: String,
    pub(crate) generation: u64,
    pub(crate) output_started: bool,
    pub(crate) tool_seen: bool,
    pub(crate) answer: Option<String>,
    pub(crate) result_failed: bool,
    /// The wrapper sent Claude an `interrupt` control request for this turn.
    pub(crate) interrupt_requested: bool,
    /// Claude echoed this turn's input back (`isReplay`), so it has consumed it.
    pub(crate) input_replayed: bool,
    /// The result reported `terminal_reason: prompt_too_long`.
    pub(crate) context_exhausted: bool,
    /// A `rate_limit_event` rejected this turn on a used-up usage window.
    pub(crate) usage_limit: Option<UsageLimit>,
    pub(crate) usage: Option<protocol::LlmUsage>,
    pub(crate) done: Option<tokio::sync::oneshot::Sender<()>>,
}

/// One long-lived `claude --print --input-format stream-json ...` process that
/// serves every turn for this agent instance. Context carries across turns
/// inside the process (verified empirically), so `--resume` is used only on
/// (re)spawn: for a `:reborn` of a dormant instance, and for crash recovery.
/// What a session reports about itself, assembled by the session because every
/// part of it is derived from state the session owns.
pub(crate) struct SessionPresentation {
    pub(crate) current_model: Option<String>,
    pub(crate) current_effort: Option<String>,
    pub(crate) models: Vec<protocol::AgentModelInfo>,
    pub(crate) commands: Option<Vec<protocol::AgentInstanceCommand>>,
    pub(crate) parameters: Vec<protocol::HarnessParameter>,
    pub(crate) goal: Option<protocol::AgentGoalStatus>,
}

impl SessionPresentation {
    /// The presence snapshot for this session. Every frame the session sends
    /// carries the same command list, so a turn boundary or a model switch can
    /// no longer replace the live list with the docs-only catalog.
    pub(crate) fn snapshot(self, usage: Option<protocol::LlmUsage>) -> AgentPresentationSnapshot {
        let mut snapshot = model_catalog_presentation_with_commands(
            self.current_model,
            self.models,
            self.current_effort,
            self.commands,
            usage,
        );
        snapshot.parameters = Some(self.parameters);
        snapshot
    }
}

pub(crate) struct ClaudeStreamSession {
    pub(crate) runtime_state: crate::AgentRuntimeStateTracker,
    cmd: String,
    cmd_args: Vec<String>,
    cwd: Option<String>,
    /// Hashed key locating the persisted resume session id on disk.
    resume_session_key: Option<String>,
    /// True when this instance was launched via `:reborn` (the daemon sets
    /// `XMATRIX_RESUME_REQUESTED`): the very first spawn should `--resume`.
    resume_requested: bool,
    relay: Arc<agent_instance_connection::AgentInstanceConnectionClient>,
    agent: protocol::SerializedAgent,
    process_tree: Option<process_tree::ProcessTreeGuard>,
    child: Option<Child>,
    stdin: Option<Arc<AsyncMutex<ChildStdin>>>,
    interrupt_stdin: Arc<Mutex<Option<Arc<AsyncMutex<ChildStdin>>>>>,
    reader_handle: Option<tokio::task::JoinHandle<()>>,
    watchdog_handle: Option<tokio::task::JoinHandle<()>>,
    watchdog_timings: ClaudeWatchdogTimings,
    active: Arc<AsyncMutex<Option<ActiveStreamTurn>>>,
    alive: Arc<AtomicBool>,
    /// Latest session id seen on any stdout event; persisted immediately so a
    /// restart (crash or reborn) can `--resume` even if no `result` arrived.
    last_session_id: Arc<Mutex<Option<String>>>,
    last_activity: Arc<Mutex<Instant>>,
    next_gen: u64,
    /// Set when the wrapper interrupted the last turn. Claude reports the tool
    /// call it cancels exactly like a human refusal, so the next turn must say
    /// that it was an interrupt.
    pub(crate) previous_turn_interrupted: bool,
    /// Whether the turn that ended last was cancelled, for the run loop to
    /// resume after a switch.
    pub(crate) last_turn_interrupted: bool,
    /// Whether this Claude build has the native `/goal` command, learned from
    /// the `system/init` event's `slash_commands` list. `None` until the first
    /// init arrives; goal mapping is optimistic while unknown.
    goal_supported: Arc<Mutex<Option<bool>>>,
    /// Additive slash tokens from system/init.slash_commands (names without /).
    slash_command_overlay: Arc<Mutex<Vec<String>>>,
    transcript: ClaudeTranscriptWatcher,
    /// The switchable model catalog advertised in presence updates.
    models: Vec<protocol::AgentModelInfo>,
    controls: Arc<ClaudeSessionControls>,
}

pub(crate) struct ClaudeStreamProcess {
    pub(crate) process_tree: process_tree::ProcessTreeGuard,
    pub(crate) child: Child,
    pub(crate) stdin: Arc<AsyncMutex<ChildStdin>>,
    pub(crate) reader: tokio::task::JoinHandle<()>,
    pub(crate) watchdog: tokio::task::JoinHandle<()>,
}

impl ClaudeStreamSession {
    /// What this session advertises about itself: the switchable model catalog,
    /// the commands that catalog implies, and the goal in force.
    ///
    /// The command list is *derived* from the model catalog rather than passed
    /// in: whether a runtime offers model or effort switching is a fact about
    /// this session's models, so deciding it anywhere else means two callers
    /// can disagree about the same session. The commands this Claude build
    /// enumerated in `system/init` (skills, custom commands) are part of it.
    pub(crate) fn presentation(&self) -> SessionPresentation {
        let facts = self.controls.parameter_facts();
        let models = facts.models.unwrap_or_else(|| self.models.clone());
        let has_models = !models.is_empty();
        let mut parameters = crate::harness_parameters::model_parameters(
            &models,
            self.controls.current().as_deref(),
            self.controls.current_effort().as_deref(),
        );
        parameters.extend(facts.parameters);
        let live_commands = self
            .slash_command_overlay
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone();
        SessionPresentation {
            current_model: self.controls.current(),
            current_effort: self.controls.current_effort(),
            models: models.clone(),
            parameters,
            commands: agent_commands_for_runtime_with_overlay(
                "claude",
                has_models,
                models_support_efforts(&models),
                &live_commands,
            ),
            goal: self.transcript.current().cloned(),
        }
    }

    /// Resolve a requested model against this session's catalog and switch to
    /// it. Matching by id or by model name is a property of the catalog, so it
    /// happens here rather than in each caller that has a string to honour.
    pub(crate) async fn select_model(&mut self, requested: &str) -> Result<String, String> {
        let selected =
            resolve_switchable_model(&self.presentation().models, "Claude Code", requested)?;
        self.switch_model(&selected).await.map(|()| selected)
    }

    /// Resolve a requested effort against the level catalog and switch to it.
    /// The catalog is the only validation there is — Claude accepts an
    /// unrecognized `effortLevel` without complaint — so an unknown level is
    /// refused here rather than sent and silently dropped.
    pub(crate) async fn select_effort(&mut self, requested: &str) -> Result<String, String> {
        let facts = self.controls.parameter_facts();
        let efforts = if facts.models.is_some() {
            self.presentation()
                .models
                .iter()
                .find(|m| {
                    self.controls
                        .current()
                        .as_deref()
                        .map_or(m.is_default == Some(true), |current| {
                            m.model == current || m.id == current
                        })
                })
                .and_then(|m| m.supported_reasoning_efforts.clone())
                .unwrap_or_default()
        } else {
            claude_effort_catalog()
        };
        let selected = efforts
            .into_iter()
            .find(|candidate| candidate.reasoning_effort.eq_ignore_ascii_case(requested))
            .map(|candidate| candidate.reasoning_effort)
            .ok_or_else(|| format!("Effort '{}' is not available", requested.trim()))?;
        self.switch_effort(&selected).await.map(|()| selected)
    }

    /// The goal watcher itself, lent to callers that drive its lifecycle
    /// (`poll`/`apply`/`clear`). They use its own API; the session does not
    /// mirror those calls, and nothing outside it touches its fields.
    pub(crate) fn goals_mut(&mut self) -> &mut ClaudeTranscriptWatcher {
        &mut self.transcript
    }

    /// Read what the turn just wrote to the transcript. Both facts it carries
    /// are applied here rather than by the caller, so the goal badge and the
    /// Effort chip cannot be refreshed from two different reads of one file.
    /// Returns whether the goal changed, which is the only part a caller acts
    /// on: the effort lands in the session's own controls and is reported
    /// from there like every other presence field.
    pub(crate) fn poll_transcript(&mut self) -> bool {
        let session_id = self.current_session_id();
        let poll = self.transcript.poll(session_id.as_deref());
        if let Some(effort) = poll.effort.as_deref()
            && self.controls.set_current_effort(effort)
        {
            write_current_run_effort(Some(effort));
        }
        poll.goal_changed
    }

    pub(crate) fn goals(&self) -> &ClaudeTranscriptWatcher {
        &self.transcript
    }

    pub(crate) fn new(
        cmd: &str,
        cmd_args: &[String],
        cwd: Option<&str>,
        resume_session_key: Option<String>,
        resume_requested: bool,
        relay: Arc<agent_instance_connection::AgentInstanceConnectionClient>,
        agent: protocol::SerializedAgent,
        initial_goal: Option<protocol::AgentGoalStatus>,
    ) -> Self {
        let initial_model = claude_initial_model_from_args(cmd_args);
        let initial_effort = claude_initial_effort_from_args(cmd_args);
        Self {
            runtime_state: crate::AgentRuntimeStateTracker::new("claude_code"),
            cmd: cmd.to_string(),
            cmd_args: cmd_args.to_vec(),
            cwd: cwd.map(str::to_string),
            resume_session_key,
            resume_requested,
            relay,
            agent,
            process_tree: None,
            child: None,
            stdin: None,
            interrupt_stdin: Arc::new(Mutex::new(None)),
            reader_handle: None,
            watchdog_handle: None,
            watchdog_timings: ClaudeWatchdogTimings::default(),
            active: Arc::new(AsyncMutex::new(None)),
            alive: Arc::new(AtomicBool::new(false)),
            last_session_id: Arc::new(Mutex::new(None)),
            last_activity: Arc::new(Mutex::new(Instant::now())),
            next_gen: 0,
            previous_turn_interrupted: false,
            last_turn_interrupted: false,
            goal_supported: Arc::new(Mutex::new(None)),
            slash_command_overlay: Arc::new(Mutex::new(Vec::new())),
            transcript: ClaudeTranscriptWatcher::new(cwd, initial_goal),
            models: claude_model_catalog(),
            controls: Arc::new(ClaudeSessionControls::new(initial_model, initial_effort)),
        }
    }

    /// Goal commands are rewritten for Claude unless the process has told us
    /// its build predates the native `/goal` command (< 2.1.139), in which
    /// case the message keeps today's verbatim-passthrough behavior.
    pub(crate) fn goal_mapping_enabled(&self) -> bool {
        self.goal_supported
            .lock()
            .map(|guard| *guard)
            .unwrap_or_else(|poison| *poison.into_inner())
            != Some(false)
    }

    pub(crate) fn current_session_id(&self) -> Option<String> {
        self.last_session_id
            .lock()
            .ok()
            .and_then(|guard| guard.clone())
    }

    pub(crate) fn interrupter(&self) -> ClaudeStreamInterrupter {
        ClaudeStreamInterrupter {
            stdin: self.interrupt_stdin.clone(),
            active: self.active.clone(),
            controls: self.controls.clone(),
        }
    }

    /// Resume id for the next (re)spawn: prefer the live session id captured by
    /// the reader (crash recovery), else the on-disk id when this is a `:reborn`
    /// first spawn. A plain fresh spawn resumes nothing.
    ///
    /// For a `:reborn` first spawn the on-disk id may have been captured in a
    /// *different* working directory (e.g. the instance was born in the base
    /// checkout before worktree isolation moved it into a per-channel worktree).
    /// Claude resolves `--resume` per-cwd, so resuming such an id would silently
    /// drag in an unrelated conversation. We refuse it with a hard error instead.
    /// The live-session id (crash recovery) was produced in this very cwd, so it
    /// is trusted without a lookup.
    fn resume_id_for_spawn(&self) -> error::Result<Option<String>> {
        if let Some(id) = self
            .last_session_id
            .lock()
            .ok()
            .and_then(|guard| guard.clone())
        {
            return Ok(Some(id));
        }
        if self.resume_requested
            && let Some(id) = load_claude_resume_session_id(self.resume_session_key.as_deref())
        {
            let cwd = match self.cwd.as_deref() {
                Some(cwd) => PathBuf::from(cwd),
                None => std::env::current_dir().map_err(|err| {
                    CliError::Launch(format!(
                        "Failed to resolve working directory for resume validation: {err}"
                    ))
                })?,
            };
            return match claude_reborn_resume_refusal(&id, &cwd) {
                None => Ok(Some(id)),
                Some(refusal) => Err(CliError::Launch(refusal)),
            };
        }
        Ok(None)
    }

    async fn ensure_alive(&mut self) -> error::Result<()> {
        if self.alive.load(Ordering::SeqCst) && self.stdin.is_some() {
            return Ok(());
        }
        self.respawn().await
    }

    async fn respawn(&mut self) -> error::Result<()> {
        self.kill_process().await;
        let resume_id = self.resume_id_for_spawn()?;
        let selected_model = self.controls.selected();
        let selected_effort = self.controls.selected_effort();
        let proc = start_claude_stream_process(
            ClaudeStreamLaunch {
                cmd: &self.cmd,
                cmd_args: &self.cmd_args,
                cwd: self.cwd.as_deref(),
                resume_id: resume_id.as_deref(),
                model: selected_model.as_deref(),
                effort: selected_effort.as_deref(),
            },
            ClaudeStreamShared {
                relay: self.relay.clone(),
                agent: self.agent.clone(),
                active: self.active.clone(),
                alive: self.alive.clone(),
                last_activity: self.last_activity.clone(),
                session: ClaudeSessionState {
                    last_session_id: self.last_session_id.clone(),
                    resume_session_key: self.resume_session_key.clone(),
                    goal_supported: self.goal_supported.clone(),
                    slash_command_overlay: self.slash_command_overlay.clone(),
                    model_state: self.controls.clone(),
                },
                probe_stdin: self.interrupt_stdin.clone(),
                watchdog_timings: self.watchdog_timings,
                runtime_state: self.runtime_state.clone(),
            },
        )?;
        *self
            .last_activity
            .lock()
            .unwrap_or_else(|poison| poison.into_inner()) = Instant::now();
        self.process_tree = Some(proc.process_tree);
        self.child = Some(proc.child);
        self.stdin = Some(proc.stdin.clone());
        *self
            .interrupt_stdin
            .lock()
            .unwrap_or_else(|poison| poison.into_inner()) = Some(proc.stdin);
        self.reader_handle = Some(proc.reader);
        self.watchdog_handle = Some(proc.watchdog);
        self.alive.store(true, Ordering::SeqCst);
        *self
            .controls
            .native_parameters
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Default::default();
        let selected = self
            .controls
            .selected_parameters
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        if selected.is_empty() {
            // Discovery runs alongside a normal first turn. Only a parameter
            // request waits for discovery before it may submit work.
            let request =
                crate::claude_parameters::initialize_request(&self.controls.parameter_request_id());
            crate::runtime_claude_stream_io::write_claude_control_line(
                &self.interrupt_stdin,
                &request,
            )
            .await;
        } else {
            let restore: Result<(), String> = async {
                self.refresh_parameters().await?;
                for (id, value) in &selected {
                    crate::harness_parameters::validate(
                        &self.presentation().parameters,
                        id,
                        value,
                    )?;
                }
                self.apply_parameter_settings(&selected).await?;
                self.refresh_parameters().await?;
                self.confirm_parameters(&selected)
            }
            .await;
            if let Err(error) = restore {
                self.kill_process().await;
                return Err(CliError::Launch(error));
            }
        }
        Ok(())
    }

    /// Stop the process and forget its session, in memory and on disk, so the
    /// next turn spawns a fresh Claude session instead of resuming this one.
    async fn retire_session(&mut self) {
        let retired = self.current_session_id();
        self.kill_process().await;
        self.resume_requested = false;
        *self
            .last_session_id
            .lock()
            .unwrap_or_else(|poison| poison.into_inner()) = None;
        clear_claude_resume_session_id(self.resume_session_key.as_deref(), retired.as_deref());
        eprintln!(
            "{} Claude's context window is exhausted; retired session {} and the next message starts a fresh one",
            "⚠".yellow().bold(),
            retired.as_deref().unwrap_or("(unknown)")
        );
    }

    async fn kill_process(&mut self) {
        crate::write_current_run_presentation_pending(false);
        self.alive.store(false, Ordering::SeqCst);
        if let Some(handle) = self.reader_handle.take() {
            handle.abort();
            // Its commit/EOF cleanup must finish before a successor marks a
            // new first presentation pending on this same wrapper's marker.
            let _ = handle.await;
        }
        if let Some(handle) = self.watchdog_handle.take() {
            handle.abort();
        }
        self.stdin = None;
        *self
            .interrupt_stdin
            .lock()
            .unwrap_or_else(|poison| poison.into_inner()) = None;
        if let Some(mut process_tree) = self.process_tree.take() {
            let _ = process_tree.terminate();
        }
        if let Some(mut child) = self.child.take() {
            let _ = child.start_kill();
            let _ = child.wait().await;
        }
        // Clear any stale active turn so a fresh spawn starts clean.
        *self.active.lock().await = None;
    }

    async fn write_user(&self, content_blocks: Vec<Value>) -> error::Result<()> {
        let Some(stdin) = self.stdin.clone() else {
            return Err(CliError::Launch(
                "Claude stream stdin unavailable".to_string(),
            ));
        };
        let bytes = serde_json::to_vec(&claude_stream_user_message(content_blocks))
            .map_err(|err| CliError::Launch(format!("Claude stream encode failed: {err}")))?;
        write_json_line(&stdin, bytes, "Claude stream")
            .await
            .map_err(CliError::Launch)
    }

    /// Write one control request to the live process and wait for the
    /// `control_response` that answers it. Both switches need exactly this
    /// correlate/write/await dance, so it is spelled once.
    ///
    /// A dead process is not a failure: the caller records the selection and
    /// the next spawn carries it as a launch flag.
    async fn apply_live_control(
        &self,
        request_id: String,
        build: impl FnOnce(&str) -> Value,
        unconfirmed: &str,
    ) -> Result<(), String> {
        if !self.alive.load(Ordering::SeqCst) {
            return Ok(());
        }
        let Some(stdin) = self.stdin.clone() else {
            return Ok(());
        };
        let (waiter_tx, waiter_rx) = tokio::sync::oneshot::channel();
        self.controls
            .register_control(request_id.clone(), waiter_tx);
        let write_result = async {
            let bytes = serde_json::to_vec(&build(&request_id))
                .map_err(|err| format!("Claude stream encode failed: {err}"))?;
            write_json_line(&stdin, bytes, "Claude stream").await
        }
        .await;
        if let Err(err) = write_result {
            self.controls.resolve_control(&request_id);
            return Err(err);
        }
        match tokio::time::timeout(CLAUDE_CONTROL_SWITCH_TIMEOUT, waiter_rx).await {
            Ok(Ok(Ok(()))) => Ok(()),
            Ok(Ok(Err(err))) => Err(err),
            // Reader dropped the waiter (process died) or no response arrived
            // in time: nothing confirmed the switch, so report failure and
            // leave the previous selection in place.
            Ok(Err(_)) | Err(_) => {
                self.controls.resolve_control(&request_id);
                Err(unconfirmed.to_string())
            }
        }
    }

    /// Applies a model switch. With a live process this goes through the
    /// `set_model` control request so the running session picks it up
    /// immediately (Claude validates the value and answers with a
    /// `control_response`); without one the selection simply waits for the
    /// next spawn. Either way the selection is recorded and re-applied via
    /// `--model` on every future (re)spawn.
    pub(crate) async fn switch_model(&mut self, model: &str) -> Result<(), String> {
        self.apply_live_control(
            format!("xmatrix-set-model-{}", uuid::Uuid::new_v4()),
            |request_id| claude_set_model_control_request(request_id, model),
            "Claude did not confirm the model switch",
        )
        .await?;
        self.controls.set_selected(model);
        let changed = self.controls.set_current(model);
        write_current_run_model(Some(model));
        let reset_fast = changed
            && self
                .controls
                .selected_parameters
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove("fast")
                .is_some();
        if self.controls.parameter_facts().models.is_some() {
            let refresh: Result<(), String> = async {
                let reset = std::collections::BTreeMap::from([("fast".into(), "off".into())]);
                if reset_fast {
                    self.apply_parameter_settings(&reset).await?;
                }
                self.refresh_parameters().await?;
                if reset_fast {
                    self.confirm_parameters(&reset)?;
                }
                Ok(())
            }
            .await;
            if let Err(error) = refresh {
                self.kill_process().await;
                return Err(error);
            }
        }
        Ok(())
    }

    /// Applies an effort switch, the mirror of `switch_model` with one
    /// difference that matters: `apply_flag_settings` answers `success` for a
    /// level Claude does not recognize, so its `control_response` proves the
    /// process is listening and nothing more. `select_effort` has already
    /// rejected anything outside the catalog by the time we get here.
    pub(crate) async fn switch_effort(&mut self, effort: &str) -> Result<(), String> {
        self.apply_live_control(
            format!("xmatrix-set-effort-{}", uuid::Uuid::new_v4()),
            |request_id| claude_apply_effort_control_request(request_id, effort),
            "Claude did not confirm the effort switch",
        )
        .await?;
        self.controls.set_selected_effort(effort);
        write_current_run_effort(Some(effort));
        Ok(())
    }

    async fn refresh_parameters(&self) -> Result<(), String> {
        *self
            .controls
            .native_parameters
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Default::default();
        self.apply_live_control(
            self.controls.parameter_request_id(),
            crate::claude_parameters::initialize_request,
            "Claude did not report its parameter catalog",
        )
        .await
    }

    pub(crate) async fn discover_parameters(&mut self) -> Result<(), String> {
        self.ensure_alive().await.map_err(|e| e.to_string())?;
        self.refresh_parameters().await
    }

    async fn apply_parameter_settings(
        &self,
        values: &std::collections::BTreeMap<String, String>,
    ) -> Result<(), String> {
        self.apply_live_control(
            format!("xmatrix-parameters-set-{}", uuid::Uuid::new_v4()),
            |id| crate::claude_parameters::settings_request(id, values),
            "Claude did not confirm parameter settings",
        )
        .await
    }

    fn confirm_parameters(
        &self,
        values: &std::collections::BTreeMap<String, String>,
    ) -> Result<(), String> {
        let facts = self.controls.parameter_facts();
        for (id, value) in values {
            let confirmed = if id == "fast" {
                facts.fast_state.as_deref() == Some(value)
                    || value == "on" && facts.fast_state.as_deref() == Some("cooldown")
            } else {
                facts
                    .parameters
                    .iter()
                    .any(|p| p.id == *id && p.current_value.as_deref() == Some(value))
            };
            if !confirmed {
                return Err(format!(
                    "Claude did not apply '{id}': {}",
                    if id == "fast" {
                        facts
                            .fast_disabled_reason
                            .as_deref()
                            .unwrap_or("reported state differs")
                    } else {
                        "reported state differs"
                    }
                ));
            }
        }
        Ok(())
    }

    pub(crate) async fn select_parameter(
        &mut self,
        id: &str,
        value: &str,
    ) -> Result<String, String> {
        self.discover_parameters().await?;
        let parameters = self.presentation().parameters;
        let parameter = crate::harness_parameters::validate(&parameters, id, value)?;
        let value = crate::harness_parameters::canonical_value(parameter, value).unwrap();
        let mut selected = self
            .controls
            .selected_parameters
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        selected.insert(id.into(), value.into());
        let apply: Result<(), String> = async {
            self.apply_parameter_settings(&selected).await?;
            self.refresh_parameters().await?;
            self.confirm_parameters(&selected)
        }
        .await;
        if let Err(error) = apply {
            // Unconfirmed session overlays must never reach a later task.
            self.kill_process().await;
            return Err(error);
        }
        *self
            .controls
            .selected_parameters
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = selected;
        let cooldown = id == "fast"
            && self.controls.parameter_facts().fast_state.as_deref() == Some("cooldown");
        Ok(format!(
            "{id}: {value}{}",
            if cooldown {
                " (cooldown; temporarily using standard speed)"
            } else {
                ""
            }
        ))
    }

    /// Submit one turn and block until its `result` event, restarting the
    /// process at most once if the transport dies. Strictly serial: the caller
    /// never invokes this concurrently, so a single active turn is unambiguous.
    pub(crate) async fn submit_turn(
        &mut self,
        _prompt: &str,
        content_blocks: Vec<Value>,
        channel_id: &str,
    ) -> ClaudeStreamOutcome {
        let mut last_usage = None;
        for attempt in 0u8..2 {
            if let Err(err) = self.ensure_alive().await {
                return ClaudeStreamOutcome {
                    answer: format!("Failed to start Claude stream process: {err}"),
                    usage: last_usage,
                    status: ClaudeTurnStatus::TransportFailed,
                    usage_limit: None,
                };
            }

            let (done_tx, done_rx) = tokio::sync::oneshot::channel::<()>();
            let generation = self.next_gen;
            self.next_gen = self.next_gen.wrapping_add(1);
            {
                let mut guard = self.active.lock().await;
                *guard = Some(ActiveStreamTurn {
                    channel_id: channel_id.to_string(),
                    generation,
                    done: Some(done_tx),
                    ..ActiveStreamTurn::default()
                });
            }
            // Reset the idle clock so the watchdog measures silence from the
            // moment we hand work to the process, not from the previous turn.
            *self
                .last_activity
                .lock()
                .unwrap_or_else(|poison| poison.into_inner()) = Instant::now();

            if let Err(err) = self.write_user(content_blocks.clone()).await {
                self.kill_process().await;
                // Nothing was accepted by the process, so a retry is safe.
                if attempt == 0 {
                    continue;
                }
                return ClaudeStreamOutcome {
                    answer: format!("Claude stream write failed: {err}"),
                    usage: last_usage,
                    status: ClaudeTurnStatus::TransportFailed,
                    usage_limit: None,
                };
            }

            match done_rx.await {
                Ok(()) => {
                    let turn = self.active.lock().await.take().unwrap_or_default();
                    if turn.context_exhausted {
                        self.retire_session().await;
                    }
                    return ClaudeStreamOutcome {
                        answer: turn.answer.unwrap_or_default(),
                        usage: turn.usage,
                        status: ClaudeTurnStatus::for_result(
                            turn.result_failed,
                            turn.interrupt_requested,
                            turn.context_exhausted,
                        ),
                        usage_limit: turn.usage_limit,
                    };
                }
                Err(_) => {
                    // Reader dropped the sender: stdout EOF, child exit, or the
                    // watchdog tripping on a hang. Inspect how far the turn got
                    // to decide whether re-injecting it could double a side
                    // effect.
                    let (output_started, tool_seen, partial_usage) = {
                        let guard = self.active.lock().await;
                        guard
                            .as_ref()
                            .map(|turn| (turn.output_started, turn.tool_seen, turn.usage.clone()))
                            .unwrap_or((false, false, None))
                    };
                    last_usage = merge_llm_usage(last_usage, partial_usage);
                    // A signal exit means someone outside this wrapper killed
                    // the process on purpose. Auto-`--resume` here resurrects
                    // exactly what the operator tried to stop, so an external
                    // kill ends the turn instead of triggering crash recovery.
                    let externally_terminated = self
                        .child
                        .as_mut()
                        .and_then(|child| child.try_wait().ok().flatten())
                        .map(exit_status_signal_terminated)
                        .unwrap_or(false);
                    self.kill_process().await;
                    if externally_terminated {
                        return ClaudeStreamOutcome {
                            answer: "The Claude process was terminated by an external signal, so \
                                     this turn did not finish. The session was not restarted \
                                     automatically; send another message to restart it, or use \
                                     `:reborn` to resume the conversation."
                                .to_string(),
                            usage: last_usage,
                            status: ClaudeTurnStatus::TransportFailed,
                            usage_limit: None,
                        };
                    }

                    let safe_to_reinject = !output_started && !tool_seen;
                    if attempt == 0 && safe_to_reinject {
                        if matches!(self.resume_id_for_spawn(), Ok(Some(_))) {
                            self.resume_requested = false;
                            if let Ok(mut guard) = self.last_session_id.lock() {
                                *guard = None;
                            }
                            eprintln!(
                                "{} Claude resume failed before accepting work; retrying without --resume",
                                "⚠".yellow().bold()
                            );
                        }
                        continue;
                    }
                    let answer = if output_started || tool_seen {
                        "The Claude process exited mid-turn, so this turn's result is indeterminate. \
                         The session will resume from where it left off on the next message."
                            .to_string()
                    } else {
                        "The Claude process exited before responding.".to_string()
                    };
                    return ClaudeStreamOutcome {
                        answer,
                        usage: last_usage,
                        status: ClaudeTurnStatus::TransportFailed,
                        usage_limit: None,
                    };
                }
            }
        }

        ClaudeStreamOutcome {
            answer: "Claude stream turn failed after a restart attempt.".to_string(),
            usage: last_usage,
            status: ClaudeTurnStatus::TransportFailed,
            usage_limit: None,
        }
    }

    #[cfg(all(test, unix))]
    pub(crate) fn set_watchdog_timings(&mut self, timings: ClaudeWatchdogTimings) {
        self.watchdog_timings = timings;
    }

    pub(crate) async fn shutdown(&mut self) {
        self.kill_process().await;
    }
}
