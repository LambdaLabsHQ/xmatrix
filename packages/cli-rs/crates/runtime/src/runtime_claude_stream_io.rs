// The stream process itself: spawning it, reading its output, watching for a
// stall, and publishing traces as they arrive.

use crate::agent_presentation::AgentPresentationAdapter;
use colored::Colorize;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

use std::collections::{HashMap, HashSet};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Instant;

use serde_json::Value;
use tokio::io::BufReader;
use tokio::process::ChildStdin;
use tokio::sync::Mutex as AsyncMutex;

use crate::runtime_channel_activity::{
    ChannelActivityReporter, claude_todo_steps, creates_pull_request, publish_channel_activity,
    publish_effects, publish_intent,
};
use crate::runtime_claude_messages::claude_assistant_delta_for_message;
use crate::runtime_claude_messages::claude_assistant_text;
use crate::runtime_claude_messages::claude_frame_is_subagent;
use crate::runtime_claude_messages::claude_init_details;
use crate::runtime_claude_messages::claude_message_id;
use crate::runtime_claude_messages::claude_runtime_notice_payload;
use crate::runtime_claude_messages::claude_tool_item_key;
use crate::runtime_claude_messages::claude_tool_name;
use crate::runtime_claude_messages::claude_tool_result_blocks;
use crate::runtime_claude_messages::claude_tool_use_blocks;
use crate::runtime_claude_stream_session::ActiveStreamTurn;
use crate::runtime_claude_stream_session::ClaudeParkedQuestion;
use crate::runtime_claude_stream_session::ClaudeSessionControls;
use crate::runtime_claude_stream_session::ClaudeStreamProcess;
use crate::runtime_claude_stream_session::ClaudeWatchdogTimings;
use crate::runtime_claude_turn::claude_control_response_outcome;
use crate::runtime_claude_turn::claude_inbound_control_response;
use crate::runtime_claude_turn::claude_liveness_probe_control_request;
use crate::runtime_claude_turn::claude_model_catalog;
use crate::runtime_claude_turn::claude_result_is_cli_originated;
use crate::runtime_claude_turn::save_claude_resume_session_id;
use crate::runtime_claude_turn::{
    ClaudeToolPermission, claude_cancelled_control_request, claude_permission_response,
    claude_tool_permission,
};
use crate::runtime_harness_questions::{
    claude_questions, publish_questionnaire, questionnaire_message,
};
use crate::runtime_trusted_role_prompt::claude_stream_extra_args;
use crate::runtime_trusted_role_prompt::trusted_role_system_prompt_from_env;
use crate::runtime_usage_limit::{claude_rate_limit_rejection, usage_limit_from_error};
use crate::runtime_waiting::{ToolWaits, background_wait, claude_tool_wait};
use crate::{
    AgentPresentationFacts, CliError, PresencePatch, agent_instance_connection,
    agent_presentation_adapter_for_runtime, apply_windows_utf8_env_tokio, error, extract_llm_model,
    extract_llm_usage, merge_llm_usage, process_tree, protocol, record_claude_rate_limit_event,
    send_llm_trace_with_source, send_presence, send_presence_committed, shell_wrap,
    slash_tokens_from_init_value, write_current_run_background_tasks, write_current_run_effort,
    write_current_run_model,
};

/// Claude's own account of its background tasks: `system/task_started` opens
/// one, and it closes on a `system/task_notification` or `system/task_updated`
/// that reports it ended; repeats are no-ops. One per provider process, so a
/// restarted provider never inherits its predecessor's tasks. The daemon reads
/// the count to tell a Run that is between turns from one that is idle
/// (docs/instance-sleep.md §2).
/// The provider process whose stream last started being read. Only its reader
/// may write the count: a predecessor's reader that finishes late must not
/// overwrite what the current provider reported. The check and the write
/// happen under this one lock, as does taking a new generation.
static CLAUDE_STREAM_GENERATION: Mutex<u64> = Mutex::new(0);

/// Take the next generation and publish its starting count in one step.
fn start_background_task_generation(count: Option<u32>) -> u64 {
    let mut current = CLAUDE_STREAM_GENERATION
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    *current += 1;
    write_current_run_background_tasks(count);
    *current
}

fn publish_background_tasks(generation: u64, count: Option<u32>) {
    let current = CLAUDE_STREAM_GENERATION
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    if *current == generation {
        write_current_run_background_tasks(count);
    }
}

#[derive(Debug, Default)]
pub(crate) struct ClaudeBackgroundTasks {
    /// Task id to its description.
    running: HashMap<String, String>,
}

impl ClaudeBackgroundTasks {
    /// The new count when this frame changed it.
    pub(crate) fn observe(&mut self, value: &Value) -> Option<u32> {
        if value.get("type").and_then(Value::as_str) != Some("system") {
            return None;
        }
        let task_id = value.get("task_id").and_then(Value::as_str)?;
        let changed = match value.get("subtype").and_then(Value::as_str)? {
            "task_started" => {
                let description = value
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                self.running
                    .insert(task_id.to_string(), description.to_string())
                    .is_none()
            }
            // A notification may be suppressed, so an update that ends the
            // task closes it too. Only an ending status does: `running` or
            // `paused` leaves it open. Statuses as the Agent SDK types them
            // (`TERMINAL_TASK_STATUSES`).
            "task_notification"
                if matches!(
                    value.get("status").and_then(Value::as_str),
                    Some("completed" | "failed" | "stopped" | "killed")
                ) =>
            {
                self.running.remove(task_id).is_some()
            }
            "task_updated"
                if matches!(
                    value.pointer("/patch/status").and_then(Value::as_str),
                    Some("completed" | "failed" | "stopped" | "killed")
                ) =>
            {
                self.running.remove(task_id).is_some()
            }
            // A watch or queued task may first appear as an update, including
            // after resume. Nonterminal updates are evidence of outstanding
            // work even when this stream never saw task_started.
            "task_updated" => {
                value.pointer("/patch/status").and_then(Value::as_str)?;
                if self.running.contains_key(task_id) {
                    false
                } else {
                    self.running.insert(task_id.to_string(), String::new());
                    true
                }
            }
            _ => return None,
        };
        changed.then(|| self.count())
    }

    pub(crate) fn count(&self) -> u32 {
        u32::try_from(self.running.len()).unwrap_or(u32::MAX)
    }

    /// Descriptions of the tasks still open: what the Instance waits on
    /// between turns, and the record when the provider exits before finishing
    /// them.
    pub(crate) fn open_descriptions(&self) -> Vec<&str> {
        let mut open: Vec<&str> = self.running.values().map(String::as_str).collect();
        open.sort_unstable();
        open
    }
}

/// What a stream process is started with: its command line and the
/// session's resume, model and effort choices.
pub(crate) struct ClaudeStreamLaunch<'a> {
    pub(crate) cmd: &'a str,
    pub(crate) cmd_args: &'a [String],
    pub(crate) cwd: Option<&'a str>,
    pub(crate) resume_id: Option<&'a str>,
    pub(crate) model: Option<&'a str>,
    pub(crate) effort: Option<&'a str>,
}

/// The state a stream process's reader and watchdog share with its session.
pub(crate) struct ClaudeStreamShared {
    pub(crate) relay: Arc<agent_instance_connection::AgentInstanceConnectionClient>,
    pub(crate) agent: protocol::SerializedAgent,
    pub(crate) active: Arc<AsyncMutex<Option<ActiveStreamTurn>>>,
    pub(crate) alive: Arc<AtomicBool>,
    pub(crate) last_activity: Arc<Mutex<Instant>>,
    pub(crate) session: ClaudeSessionState,
    pub(crate) probe_stdin: Arc<Mutex<Option<Arc<AsyncMutex<ChildStdin>>>>>,
    pub(crate) watchdog_timings: ClaudeWatchdogTimings,
    pub(crate) runtime_state: crate::AgentRuntimeStateTracker,
}

/// What the reader keeps current for its session: the resumable session id,
/// the native command list and goal support, and the model controls.
pub(crate) struct ClaudeSessionState {
    pub(crate) last_session_id: Arc<Mutex<Option<String>>>,
    pub(crate) resume_session_key: Option<String>,
    pub(crate) goal_supported: Arc<Mutex<Option<bool>>>,
    pub(crate) slash_command_overlay: Arc<Mutex<Vec<String>>>,
    pub(crate) model_state: Arc<ClaudeSessionControls>,
}

pub(crate) fn start_claude_stream_process(
    launch: ClaudeStreamLaunch<'_>,
    shared: ClaudeStreamShared,
) -> error::Result<ClaudeStreamProcess> {
    let ClaudeStreamLaunch {
        cmd,
        cmd_args,
        cwd,
        resume_id,
        model,
        effort,
    } = launch;
    let ClaudeStreamShared {
        relay,
        agent,
        active,
        alive,
        last_activity,
        session,
        probe_stdin,
        watchdog_timings,
        runtime_state,
    } = shared;
    // A daemon-spawned wrapper can carry a launcher id (for example
    // `cmd:claude_code`) which is identity/lineage metadata, not an executable
    // name. The daemon separately records the Profile's reviewed runtime in
    // XMATRIX_SPAWN_RUNTIME; keep that value authoritative when the wrapper
    // starts Claude's child stream.
    let expected_runtime = std::env::var("XMATRIX_SPAWN_RUNTIME").ok();
    let runtime_cmd = claude_stream_runtime_command(cmd, expected_runtime.as_deref());
    let (spawn_cmd, mut spawn_args) = shell_wrap(runtime_cmd, cmd_args);
    let role_system_prompt = trusted_role_system_prompt_from_env();
    spawn_args.extend(claude_stream_extra_args(
        resume_id,
        model,
        effort,
        role_system_prompt.as_deref(),
    ));

    // Advance past restored history before the provider can append this
    // process's first assistant record. Priming on init would race a buffered
    // stdout stream and discard the first turn's actual effort.
    let mut effort_transcript =
        crate::runtime_agent_goal_status::ClaudeTranscriptWatcher::new(cwd, None);
    effort_transcript.poll(resume_id);
    let mut command = tokio::process::Command::new(&spawn_cmd);
    let presentation_pending = crate::write_current_run_presentation_pending(true);
    apply_windows_utf8_env_tokio(&mut command)?;
    if let Some(dir) = cwd {
        command.current_dir(dir);
    }
    // Set after the sandbox env rebuild so nested `xmatrix goal` calls from the
    // model's own tools reach this instance's inbox in both env modes.
    if let Some(inbox) = crate::bound_goal_inbox_path() {
        command.env(crate::GOAL_INBOX_ENV, inbox);
    }
    command
        .args(&spawn_args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    process_tree::configure_tokio_process_tree(&mut command);
    let mut child = command.spawn().map_err(|err| {
        crate::write_current_run_presentation_pending(false);
        CliError::Launch(format!(
            "Failed to start Claude stream process '{}': {err}",
            spawn_cmd
        ))
    })?;
    let process_tree = process_tree::guard_tokio_child(&mut child).map_err(|err| {
        CliError::Launch(format!(
            "Failed to bind Claude stream process to its process tree: {err}"
        ))
    })?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| CliError::Launch("Claude stream stdin unavailable".to_string()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| CliError::Launch("Claude stream stdout unavailable".to_string()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| CliError::Launch("Claude stream stderr unavailable".to_string()))?;

    // Drain stderr so the pipe never fills (which would back-pressure and stall
    // the child); surface non-empty lines for diagnostics.
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if !line.trim().is_empty() {
                eprintln!("{} {line}", "claude:".dimmed());
            }
        }
    });

    // The channel of a turn Claude started by itself, shared so the watchdog
    // can guard it too; `None` when no such turn is open.
    let cli_turn_channel: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let reader = tokio::spawn(claude_stream_reader(
        stdout,
        relay.clone(),
        agent.clone(),
        active.clone(),
        alive.clone(),
        last_activity.clone(),
        ClaudeStreamReadContext {
            session,
            control_stdin: probe_stdin.clone(),
            cli_turn_channel: cli_turn_channel.clone(),
            effort_transcript,
            presentation_pending,
            runtime_state,
            tool_wait_threshold: watchdog_timings.tool_wait,
        },
    ));
    let watchdog = tokio::spawn(claude_stream_watchdog(
        active,
        alive,
        last_activity,
        probe_stdin,
        cli_turn_channel,
        relay,
        agent,
        watchdog_timings,
    ));

    Ok(ClaudeStreamProcess {
        process_tree,
        child,
        stdin: Arc::new(AsyncMutex::new(stdin)),
        reader,
        watchdog,
    })
}

pub(crate) fn claude_stream_runtime_command<'a>(
    cmd: &'a str,
    expected_runtime: Option<&'a str>,
) -> &'a str {
    expected_runtime
        .map(str::trim)
        .filter(|runtime| !runtime.is_empty())
        .filter(|runtime| {
            crate::is_claude_launcher_token(cmd) && crate::is_claude_launcher_token(runtime)
        })
        .unwrap_or(cmd)
}

/// Every native discovery/model frame carries the same confirmed facts. In
/// particular a late initialize reply must retain the model/effort already
/// observed earlier in the first turn.
fn claude_observed_presentation(
    controls: &ClaudeSessionControls,
    overlay: &[String],
) -> crate::AgentPresentationSnapshot {
    let facts = controls.parameter_facts();
    let models = facts.models.unwrap_or_else(claude_model_catalog);
    let model = controls.current();
    let effort = controls.current_effort();
    let mut parameters =
        crate::harness_parameters::model_parameters(&models, model.as_deref(), effort.as_deref());
    parameters.extend(facts.parameters);
    agent_presentation_adapter_for_runtime("claude").present(
        &AgentPresentationFacts {
            model,
            effort,
            models,
            models_reported: true,
            parameters: Some(parameters),
            ..Default::default()
        },
        overlay,
    )
}

pub(crate) struct ClaudeStreamReadContext {
    pub(crate) session: ClaudeSessionState,
    pub(crate) control_stdin: Arc<Mutex<Option<Arc<AsyncMutex<ChildStdin>>>>>,
    pub(crate) cli_turn_channel: Arc<Mutex<Option<String>>>,
    pub(crate) effort_transcript: crate::runtime_agent_goal_status::ClaudeTranscriptWatcher,
    pub(crate) presentation_pending: bool,
    /// Shared with the turn submitter, whose `idle` report carries the wait.
    pub(crate) runtime_state: crate::AgentRuntimeStateTracker,
    pub(crate) tool_wait_threshold: std::time::Duration,
}

/// Continuously drains one process's stdout: persists session ids, republishes
/// streaming trace events to the active turn's channel, tracks side-effect
/// progress, and signals turn completion on each `result` event.
pub(crate) async fn claude_stream_reader(
    stdout: tokio::process::ChildStdout,
    relay: Arc<agent_instance_connection::AgentInstanceConnectionClient>,
    agent: protocol::SerializedAgent,
    active: Arc<AsyncMutex<Option<ActiveStreamTurn>>>,
    alive: Arc<AtomicBool>,
    last_activity: Arc<Mutex<Instant>>,
    context: ClaudeStreamReadContext,
) {
    let ClaudeStreamReadContext {
        session:
            ClaudeSessionState {
                last_session_id,
                resume_session_key,
                goal_supported,
                slash_command_overlay,
                model_state,
            },
        control_stdin,
        cli_turn_channel,
        mut effort_transcript,
        presentation_pending,
        runtime_state,
        tool_wait_threshold,
    } = context;
    let mut lines = BufReader::new(stdout).lines();
    let mut local_gen: Option<u64> = None;
    let mut trace = ClaudeStreamTraceState::default();
    let mut turn_usage: Option<protocol::LlmUsage> = None;
    // `system/init` is re-emitted at the start of every turn in stream-json
    // mode; only publish the first one per process so we don't spam the channel
    // with "Claude session started" each turn.
    let mut init_published = false;
    let mut initial_effort_probe_done = false;
    // A turn Claude started on its own (a background task finished), and the
    // channel it is attributed to: the one this process last served.
    let mut cli_turn: Option<(String, ClaudeStreamTraceState)> = None;
    let mut last_channel_id: Option<String> = None;
    // A provider starts background tasks only inside a turn, so one that was
    // just started has none. Its predecessor's are not assumed gone: they
    // were marked unknown when its stream ended, and this reader now owns the
    // count.
    let generation = start_background_task_generation(Some(0));
    let mut background_tasks = ClaudeBackgroundTasks::default();
    let interruption_id = uuid::Uuid::new_v4().to_string();
    let mut task_channels: HashMap<String, String> = HashMap::new();
    // What the Instance waits on (docs/design/agent-status.md): tool calls
    // left open in a running turn, or its background tasks once it ended.
    let mut tool_waits = ToolWaits::new(tool_wait_threshold);
    let mut turn_running = false;
    let mut background_since: Option<u64> = None;

    loop {
        let now = Instant::now();
        let waiting = if turn_running {
            tool_waits.waiting(now)
        } else {
            between_turns_wait(&background_tasks, &mut background_since)
        };
        report_waiting(&relay, &runtime_state, waiting);
        let next = match tool_waits.deadline(now) {
            // Wake when the oldest open call turns into a wait, unless a frame
            // arrives first. `next_line` is cancellation safe.
            Some(deadline) => tokio::select! {
                line = lines.next_line() => line,
                () = tokio::time::sleep_until(deadline.into()) => continue,
            },
            None => lines.next_line().await,
        };
        let Ok(Some(line)) = next else {
            break;
        };
        // A call's wait counts from when its frame arrived: handling the
        // frame (a first tool waits for a Hub commit) is not the tool running.
        let received = (Instant::now(), crate::unix_millis_now());
        *last_activity
            .lock()
            .unwrap_or_else(|poison| poison.into_inner()) = received.0;
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        // Capture each task's originating channel; a later turn may serve another one.
        if value.get("type").and_then(Value::as_str) == Some("system")
            && let Some(task_id) = value.get("task_id").and_then(Value::as_str)
            && let Some("task_started") = value.get("subtype").and_then(Value::as_str)
        {
            let channel = active
                .lock()
                .await
                .as_ref()
                .map(|turn| turn.channel_id.clone())
                .or_else(|| last_channel_id.clone());
            if let Some(channel) = channel {
                task_channels.entry(task_id.to_string()).or_insert(channel);
            }
        }
        // Before any filter: a subagent's background task keeps the Run busy too.
        if let Some(count) = background_tasks.observe(&value) {
            publish_background_tasks(generation, Some(count));
        }
        task_channels.retain(|task_id, _| background_tasks.running.contains_key(task_id));

        // AskUserQuestion waits on its person: park it and show its card in
        // the channel the turn serves. Any other tool runs as before.
        match claude_tool_permission(&value) {
            Some(ClaudeToolPermission::Allow(response)) => {
                let _ = write_claude_control_line(&control_stdin, &response).await;
                continue;
            }
            Some(ClaudeToolPermission::Ask {
                request_id,
                tool_use_id,
                input,
            }) => {
                let channel = active
                    .lock()
                    .await
                    .as_ref()
                    .map(|turn| turn.channel_id.clone())
                    .or_else(|| cli_turn.as_ref().map(|(channel, _)| channel.clone()))
                    .or_else(|| last_channel_id.clone());
                let questions = claude_questions(&input);
                match channel.filter(|_| !questions.is_empty()) {
                    Some(channel) => {
                        publish_questionnaire(
                            &relay,
                            &channel,
                            questionnaire_message(
                                "claude_code",
                                "Claude",
                                &tool_use_id,
                                &questions,
                            ),
                        );
                        model_state
                            .questions
                            .park(tool_use_id, ClaudeParkedQuestion { request_id, input });
                    }
                    None => {
                        let refusal = claude_permission_response(
                            &request_id,
                            Err(
                                "xMatrix could not show this question to anyone; ask in your reply instead.",
                            ),
                        );
                        let _ = write_claude_control_line(&control_stdin, &refusal).await;
                    }
                }
                continue;
            }
            None => {}
        }
        if let Some(request_id) = claude_cancelled_control_request(&value) {
            model_state
                .questions
                .forget(|parked| parked.request_id == request_id);
            continue;
        }

        // The CLI asking the host something (an MCP elicitation, a tool
        // permission) must be answered or the turn parks until its deadline.
        if let Some(response) = claude_inbound_control_response(&value) {
            eprintln!(
                "{} Claude sent an unhandled control request; answering like the Agent SDK: {}",
                "⚠".yellow().bold(),
                value
                    .pointer("/request/subtype")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
            );
            let _ = write_claude_control_line(&control_stdin, &response).await;
            continue;
        }

        // Control responses answer our own `set_model` requests and typically
        // arrive between turns, so route them before the active-turn guard.
        if let Some((request_id, outcome)) = claude_control_response_outcome(&value) {
            let parameters_observed = model_state.observe_initialize(&value);
            if parameters_observed && outcome.is_ok() {
                let presentation = claude_observed_presentation(
                    &model_state,
                    &slash_command_overlay
                        .lock()
                        .unwrap_or_else(|p| p.into_inner()),
                );
                send_presence(
                    &relay,
                    None,
                    PresencePatch::presentation(presentation).goal_patch(None),
                );
            }
            if let Some(waiter) = model_state.resolve_control(&request_id) {
                let _ = waiter.send(outcome);
            }
            continue;
        }

        // A subagent's own frames (background or foreground Agent tool) are
        // internal to it: its narration must never become this turn's answer,
        // visible text, failure detail, or model. The frame still proves the
        // process is alive (`last_activity` above).
        if claude_frame_is_subagent(&value) {
            continue;
        }
        crate::runtime_wake_metrics::record_claude_frame(&value);

        // Track the model actually serving this session (init events carry the
        // resolved id, assistant events the id that produced the message) so
        // presence updates and `xmatrix send` message headers stay truthful.
        let value_type = value.get("type").and_then(Value::as_str);
        let model_bearing = value_type == Some("assistant")
            || (value_type == Some("system")
                && value.get("subtype").and_then(Value::as_str) == Some("init"));
        let mut presentation_changed = false;
        if model_bearing && let Some(model) = extract_llm_model(&value) {
            presentation_changed = model_state.set_current(&model);
            if presentation_changed {
                write_current_run_model(Some(&model));
            }
        }

        // Persist the session id as soon as it appears (it is present on every
        // event), so a restart can resume even if no `result` was reached.
        if let Some(session_id) = value
            .get("session_id")
            .or_else(|| value.get("sessionId"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            let changed = {
                let mut guard = last_session_id
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner());
                if guard.as_deref() == Some(session_id) {
                    false
                } else {
                    *guard = Some(session_id.to_string());
                    true
                }
            };
            if changed {
                let _ =
                    save_claude_resume_session_id(resume_session_key.as_deref(), Some(session_id));
            }
        }

        // Claude writes actual effort on assistant transcript records. Tools
        // may execute concurrently with stdout and transcript publication;
        // the child send gate below waits for this observation's Hub commit.
        // This cursor publishes no goals; the session's goal watcher retains
        // its own cursor and remains responsible for goal updates.
        if model_bearing {
            let first_assistant = value_type == Some("assistant") && !initial_effort_probe_done;
            let session_id = last_session_id
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clone();
            let mut observed = effort_transcript.poll(session_id.as_deref());
            if first_assistant {
                initial_effort_probe_done = true;
                // Native transcript writes can lag stdout by ~160ms. Give
                // unknown first-turn effort one bounded opportunity to land;
                // don't delay later frames or invent a value on timeout.
                if model_state.current_effort().is_none() {
                    let deadline =
                        tokio::time::Instant::now() + std::time::Duration::from_millis(300);
                    while observed.effort.is_none() && tokio::time::Instant::now() < deadline {
                        tokio::time::sleep_until(std::cmp::min(
                            deadline,
                            tokio::time::Instant::now() + std::time::Duration::from_millis(20),
                        ))
                        .await;
                        observed = effort_transcript.poll(session_id.as_deref());
                    }
                }
            }
            if let Some(effort) = observed.effort
                && model_state.set_current_effort(&effort)
            {
                write_current_run_effort(Some(&effort));
                presentation_changed = true;
            }
            if presentation_changed || first_assistant {
                let patch = PresencePatch::presentation(claude_observed_presentation(
                    &model_state,
                    &slash_command_overlay
                        .lock()
                        .unwrap_or_else(|p| p.into_inner()),
                ))
                .goal_patch(None);
                if first_assistant && presentation_pending {
                    if let Err(error) = send_presence_committed(&relay, None, patch).await {
                        eprintln!("First native presentation was not confirmed by Hub: {error}");
                    }
                    // Display metadata must not veto an Agent's message. On
                    // failure the Hub still stamps only its accepted facts.
                    crate::write_current_run_presentation_pending(false);
                } else {
                    send_presence(&relay, None, patch);
                }
            }
        }

        let cli_originated_result =
            value_type == Some("result") && claude_result_is_cli_originated(&value);
        let mut guard = active.lock().await;
        let Some(turn) = guard.as_mut() else {
            drop(guard);
            // No channel turn is in flight. When a background task finishes the
            // CLI starts a turn by itself (`system/task_notification`, then a
            // `result` carrying `origin`); surface it instead of dropping it, or
            // the agent looks stopped while it keeps working. Anything else
            // (startup chatter) has nothing to attribute it to.
            if cli_turn.is_none()
                && value_type == Some("system")
                && value.get("subtype").and_then(Value::as_str) == Some("task_notification")
                && let Some(channel_id) = last_channel_id.clone()
            {
                send_presence(&relay, Some("busy"), PresencePatch::default());
                send_llm_trace_with_source(
                    &relay,
                    &channel_id,
                    "turn_started",
                    "claude_code",
                    &agent,
                    None,
                    None,
                    serde_json::json!({
                        "input": value.get("summary").and_then(Value::as_str).unwrap_or_default(),
                        "origin": "task-notification",
                    }),
                )
                .await;
                set_cli_turn_channel(&cli_turn_channel, Some(channel_id.clone()));
                turn_running = true;
                tool_waits.clear();
                cli_turn = Some((
                    channel_id,
                    ClaudeStreamTraceState::with_activity(trace.take_activity()),
                ));
            }
            // The watchdog closes a hung self-started turn by clearing the
            // shared channel; whatever the process says afterwards is stale.
            if cli_turn_channel
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .is_none()
            {
                cli_turn = None;
            }
            let Some((channel_id, cli_trace)) = cli_turn.as_mut() else {
                continue;
            };
            // Claude re-emits `system/init` at the start of every turn; the
            // "session started" marker it would publish is only true once.
            let is_init = value_type == Some("system")
                && value.get("subtype").and_then(Value::as_str) == Some("init");
            if !is_init {
                publish_claude_stream_trace(&relay, channel_id, &agent, &value, cli_trace).await;
                observe_claude_tool_waits(&value, &mut tool_waits, received);
            }
            if value_type == Some("result") {
                publish_cli_turn_finished(&relay, &agent, channel_id, &value, cli_trace).await;
                turn_running = false;
                tool_waits.clear();
                runtime_state
                    .set_waiting(between_turns_wait(&background_tasks, &mut background_since));
                send_presence(
                    &relay,
                    Some("idle"),
                    PresencePatch::default().runtime_state(runtime_state.waiting_snapshot()),
                );
                set_cli_turn_channel(&cli_turn_channel, None);
                trace.activity = cli_trace.take_activity();
                cli_turn = None;
            }
            continue;
        };
        last_channel_id = Some(turn.channel_id.clone());
        if local_gen != Some(turn.generation) {
            local_gen = Some(turn.generation);
            trace.next_turn();
            turn_usage = None;
            turn_running = true;
            tool_waits.clear();
        }
        if value_type == Some("user")
            && value.get("isReplay").and_then(Value::as_bool) == Some(true)
        {
            turn.input_replayed = true;
        }
        if cli_originated_result {
            set_cli_turn_channel(&cli_turn_channel, None);
            if let Some((channel_id, mut cli_trace)) = cli_turn.take() {
                publish_cli_turn_finished(&relay, &agent, &channel_id, &value, &cli_trace).await;
                trace.activity = cli_trace.take_activity();
            }
            // Claude replays a queued input when it consumes it. Replayed before
            // this result, the input was absorbed into the self-started turn at
            // a tool boundary and this is the only result it will ever get.
            // Otherwise it sat queued behind that turn and gets its own result.
            if !turn.input_replayed {
                trace.next_turn();
                turn_usage = None;
                continue;
            }
        }

        if value_type == Some("system")
            && value.get("subtype").and_then(Value::as_str) == Some("init")
        {
            // The init event enumerates the build's slash commands:
            // - goal-capability probe (`/goal` shipped in Claude 2.1.139)
            // - additive overlay for presence.commands[] (docs catalog + live list)
            let init_tokens = slash_tokens_from_init_value(&value);
            if !init_tokens.is_empty() {
                let supported = init_tokens.iter().any(|token| {
                    token.eq_ignore_ascii_case("/goal") || token.eq_ignore_ascii_case("goal")
                });
                *goal_supported
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner()) = Some(supported);
                *slash_command_overlay
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner()) = init_tokens.clone();
                // Re-advertise commands once after first init so Composer sees live slash list.
                if !init_published {
                    let presentation = claude_observed_presentation(&model_state, &init_tokens);
                    // Goal stays `None`: this frame re-advertises the live
                    // command list, it does not speak for the current goal.
                    send_presence(
                        &relay,
                        Some("busy"),
                        PresencePatch::presentation(presentation)
                            .goal_patch(None)
                            .runtime_state(None),
                    );
                }
            } else if let Some(commands) = value.get("slash_commands").and_then(Value::as_array) {
                let supported = commands
                    .iter()
                    .any(|command| command.as_str() == Some("goal"));
                *goal_supported
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner()) = Some(supported);
            }
            if init_published {
                continue;
            }
            init_published = true;
        }

        publish_claude_stream_trace(&relay, &turn.channel_id, &agent, &value, &mut trace).await;
        observe_claude_tool_waits(&value, &mut tool_waits, received);
        turn_usage = merge_llm_usage(turn_usage, extract_llm_usage(&value));

        match value_type {
            Some("rate_limit_event") => {
                if let Some(limit) = claude_rate_limit_rejection(&value) {
                    turn.usage_limit = Some(limit);
                }
                turn_usage = merge_llm_usage(turn_usage, record_claude_rate_limit_event(&value));
            }
            Some("assistant") => {
                if !claude_assistant_text(&value).trim().is_empty() {
                    turn.output_started = true;
                }
                if !claude_tool_use_blocks(&value).is_empty() {
                    turn.tool_seen = true;
                    turn.output_started = true;
                }
            }
            Some("result") => {
                // Settled before the submitter wakes: its `idle` report
                // carries the wait, so background tasks outlive the turn.
                turn_running = false;
                tool_waits.clear();
                runtime_state
                    .set_waiting(between_turns_wait(&background_tasks, &mut background_since));
                let (answer, failed) = claude_result_answer(&value, &trace.visible_assistant_text);
                turn.answer = Some(answer);
                turn.result_failed = failed;
                turn.context_exhausted = claude_result_context_exhausted(&value);
                turn.usage = turn_usage.clone();
                let done = turn.done.take();
                drop(guard);
                if let Some(done) = done {
                    let _ = done.send(());
                }
                continue;
            }
            _ => {}
        }
    }

    // stdout closed: the transport is gone. Dropping `active`'s `done` sender
    // (it is still parked in the current turn, if any) wakes the submitter with
    // a recv error so it can recover.
    if let Some(turn) = active.lock().await.as_mut() {
        let _ = turn.done.take();
    }
    // Nothing this process ran is waited on any more.
    report_waiting(&relay, &runtime_state, None);
    // The stream ended. Keep a known zero so idle sleep can proceed; keep a
    // positive count so a watch / Monitor still holds the Run awake. Only drop
    // to unknown when we somehow have no tracker (should not happen).
    let remaining = background_tasks.count();
    if remaining > 0 {
        eprintln!(
            "{} Claude's stream ended with {} background task(s) unfinished: {}",
            "⚠".yellow().bold(),
            remaining,
            background_tasks.open_descriptions().join("; ")
        );
    }
    let mut interrupted_channels: HashMap<String, usize> = HashMap::new();
    for channel in task_channels.values() {
        *interrupted_channels.entry(channel.clone()).or_default() += 1;
    }
    for (channel, count) in interrupted_channels {
        // Only bounded facts cross into the channel; descriptions can contain private tool input.
        let _ = relay.send_message(protocol::AgentInstanceClientMessage::AgentLifecycle {
            request_id: Some(interruption_id.clone()),
            channel_id: Some(channel),
            agent_id: Some(agent.id.clone()),
            instance_id: agent.instance_id.clone(),
            agent_name: Some(agent.name.clone()),
            layer: "application".into(),
            status: "blocked".into(),
            reason: Some("background_tasks_interrupted".into()),
            detail: Some(format!("The provider stream ended with {count} task(s) still pending. Their outcome is unknown; verify external operations before continuing.")),
            snapshot: None,
            resets_at: None,
            ts: None,
        });
    }
    publish_background_tasks(generation, Some(remaining));
    if presentation_pending {
        crate::write_current_run_presentation_pending(false);
    }
    alive.store(false, Ordering::SeqCst);
}

/// Forces recovery if the process goes completely silent while a turn is in
/// flight. Dropping the turn's `done` sender wakes the submitter, which then
/// kills the hung child and decides whether re-injection is safe.
pub(crate) async fn claude_stream_watchdog(
    active: Arc<AsyncMutex<Option<ActiveStreamTurn>>>,
    alive: Arc<AtomicBool>,
    last_activity: Arc<Mutex<Instant>>,
    probe_stdin: Arc<Mutex<Option<Arc<AsyncMutex<ChildStdin>>>>>,
    cli_turn_channel: Arc<Mutex<Option<String>>>,
    relay: Arc<agent_instance_connection::AgentInstanceConnectionClient>,
    agent: protocol::SerializedAgent,
    timings: ClaudeWatchdogTimings,
) {
    let mut probe_sent_at: Option<Instant> = None;
    loop {
        tokio::time::sleep(timings.tick).await;
        if !alive.load(Ordering::SeqCst) {
            break;
        }
        let idle = last_activity
            .lock()
            .map(|instant| instant.elapsed())
            .unwrap_or_else(|poison| poison.into_inner().elapsed());
        if idle < timings.idle_limit {
            probe_sent_at = None;
            continue;
        }
        let cli_turn_open = cli_turn_channel
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .is_some();
        if !cli_turn_open && active.lock().await.is_none() {
            probe_sent_at = None;
            continue;
        }
        match probe_sent_at {
            None => {
                if write_claude_liveness_probe(&probe_stdin).await {
                    eprintln!(
                        "{} Claude produced no output for {}s during an active turn; probing the process for liveness",
                        "⚠".yellow().bold(),
                        idle.as_secs()
                    );
                    probe_sent_at = Some(Instant::now());
                    continue;
                }
            }
            Some(sent_at) if sent_at.elapsed() < timings.probe_grace => continue,
            Some(_) => {}
        }
        probe_sent_at = None;
        eprintln!(
            "{} Claude did not answer the liveness probe; treating the process as hung and recovering",
            "⚠".yellow().bold()
        );
        let mut guard = active.lock().await;
        if let Some(turn) = guard.as_mut() {
            let _ = turn.done.take();
            continue;
        }
        drop(guard);
        // A hung turn Claude started by itself has no submitter to recover it.
        // Close it on the channel and mark the process dead: the next channel
        // message respawns it (killing this one) and resumes the session.
        let channel_id = cli_turn_channel
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .take();
        if let Some(channel_id) = channel_id {
            send_llm_trace_with_source(
                &relay,
                &channel_id,
                "turn_failed",
                "claude_code",
                &agent,
                None,
                None,
                serde_json::json!({
                    "error": "Claude stopped responding while working on its own (after a background task finished). The session resumes on the next message.",
                    "executionState": "unknown",
                    "origin": "task-notification",
                }),
            )
            .await;
            send_presence(&relay, Some("idle"), PresencePatch::default());
            alive.store(false, Ordering::SeqCst);
            break;
        }
    }
}

/// Report a changed wait. The runtime state goes out whole, as every runtime
/// state report does; an unchanged wait sends nothing.
fn report_waiting(
    relay: &agent_instance_connection::AgentInstanceConnectionClient,
    runtime_state: &crate::AgentRuntimeStateTracker,
    waiting: Option<protocol::AgentRuntimeWaiting>,
) {
    if runtime_state.set_waiting(waiting) {
        send_presence(
            relay,
            None,
            PresencePatch::default().runtime_state(Some(runtime_state.snapshot())),
        );
    }
}

/// Between turns the Instance waits on its background tasks, from when the
/// first was seen running until none is.
fn between_turns_wait(
    tasks: &ClaudeBackgroundTasks,
    since: &mut Option<u64>,
) -> Option<protocol::AgentRuntimeWaiting> {
    let count = tasks.count();
    if count == 0 {
        *since = None;
        return None;
    }
    background_wait(
        count,
        &tasks.open_descriptions(),
        *since.get_or_insert_with(crate::unix_millis_now),
    )
}

/// Track the tool calls a running turn opens and closes, each from when its
/// frame arrived. Subagent frames never get here, and a subagent's own call is
/// not a wait.
fn observe_claude_tool_waits(value: &Value, waits: &mut ToolWaits, received: (Instant, u64)) {
    let (now, now_millis) = received;
    match value.get("type").and_then(Value::as_str) {
        Some("assistant") => {
            for tool in claude_tool_use_blocks(value) {
                let name = claude_tool_name(&tool).unwrap_or_default();
                let input = tool.get("input").cloned().unwrap_or(Value::Null);
                if let Some(wait) = claude_tool_wait(&name, &input) {
                    waits.open(claude_tool_item_key(&tool), wait, now, now_millis);
                }
            }
        }
        Some("user") => {
            for result in claude_tool_result_blocks(value) {
                waits.close(&claude_tool_item_key(&result));
            }
        }
        _ => {}
    }
}

fn set_cli_turn_channel(cli_turn_channel: &Mutex<Option<String>>, channel_id: Option<String>) {
    *cli_turn_channel
        .lock()
        .unwrap_or_else(|poison| poison.into_inner()) = channel_id;
}

/// The `turn_completed` / `turn_failed` trace for a turn the CLI started
/// itself, and the usage limit it ran into.
async fn publish_cli_turn_finished(
    relay: &Arc<agent_instance_connection::AgentInstanceConnectionClient>,
    agent: &protocol::SerializedAgent,
    channel_id: &str,
    result: &Value,
    trace: &ClaudeStreamTraceState,
) {
    let failed = result.get("is_error").and_then(Value::as_bool) == Some(true);
    let text = result
        .get("result")
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
        .unwrap_or_else(|| trace.visible_assistant_text.trim());
    send_llm_trace_with_source(
        relay,
        channel_id,
        if failed {
            "turn_failed"
        } else {
            "turn_completed"
        },
        "claude_code",
        agent,
        extract_llm_usage(result),
        None,
        serde_json::json!({
            "text": text,
            "executionState": if failed { "failed" } else { "completed" },
            "origin": "task-notification",
        }),
    )
    .await;
    // A background task's completion can start a turn on an account that is
    // already used up. Nobody else reports that turn, so its usage limit
    // reaches the Hub (and hands the Instance off) only from here.
    if !failed {
        crate::clear_pending_usage_limit();
    } else {
        let (answer, _) = claude_result_answer(result, &trace.visible_assistant_text);
        if let Some(limit) = usage_limit_from_error(&answer) {
            crate::report_turn_failure_with_usage_limit(
                relay,
                Some(channel_id),
                agent,
                &answer,
                false,
                Some(limit),
            );
        }
    }
}

pub(crate) async fn write_claude_liveness_probe(
    probe_stdin: &Arc<Mutex<Option<Arc<AsyncMutex<ChildStdin>>>>>,
) -> bool {
    let request_id = format!("xmatrix-liveness-{}", uuid::Uuid::new_v4());
    write_claude_control_line(
        probe_stdin,
        &claude_liveness_probe_control_request(&request_id),
    )
    .await
}

pub(crate) async fn write_claude_control_line(
    stdin: &Arc<Mutex<Option<Arc<AsyncMutex<ChildStdin>>>>>,
    line: &Value,
) -> bool {
    let Some(stdin) = stdin
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .clone()
    else {
        return false;
    };
    let Ok(mut bytes) = serde_json::to_vec(line) else {
        return false;
    };
    bytes.push(b'\n');
    let mut stdin = stdin.lock().await;
    if stdin.write_all(&bytes).await.is_err() {
        return false;
    }
    stdin.flush().await.is_ok()
}

/// Claude Code's `terminal_reason` for a turn whose context window is full and
/// could not be compacted. The session behind it can never answer again: every
/// resume replays the same oversized history.
pub(crate) const CLAUDE_TERMINAL_REASON_PROMPT_TOO_LONG: &str = "prompt_too_long";

/// Whether a `result` frame says the session's context window is exhausted.
/// Read from `terminal_reason`, not `is_error`: the CLI computes the two
/// independently, and this reason has been seen on a result that is not
/// flagged as an error.
pub(crate) fn claude_result_context_exhausted(value: &Value) -> bool {
    value
        .get("terminal_reason")
        .and_then(Value::as_str)
        .map(str::trim)
        == Some(CLAUDE_TERMINAL_REASON_PROMPT_TOO_LONG)
}

/// The answer a `result` frame carries, and whether it reports a failure.
/// A failed result names Claude's own error (`subtype`, `errors`); the
/// narration streamed before the failure is not an error message.
pub(crate) fn claude_result_answer(value: &Value, visible_assistant_text: &str) -> (String, bool) {
    let result = value
        .get("result")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|result| !result.is_empty());
    if claude_result_context_exhausted(value) {
        let mut answer = format!(
            "Claude ended the turn with terminal_reason={CLAUDE_TERMINAL_REASON_PROMPT_TOO_LONG}: \
             the session's context window is full and compaction could not recover it. \
             The next message starts a fresh Claude session."
        );
        if let Some(result) = result {
            answer.push_str(&format!(" ({result})"));
        }
        return (answer, true);
    }
    if value.get("is_error").and_then(Value::as_bool) != Some(true) {
        let answer = result.unwrap_or_else(|| visible_assistant_text.trim());
        return (answer.to_string(), false);
    }
    let mut parts: Vec<String> = Vec::new();
    if let Some(subtype) = value.get("subtype").and_then(Value::as_str) {
        parts.push(subtype.to_string());
    }
    if let Some(errors) = value.get("errors").and_then(Value::as_array) {
        parts.extend(errors.iter().map(|error| match error.as_str() {
            Some(text) => text.to_string(),
            None => error.to_string(),
        }));
    }
    if let Some(result) = result {
        parts.push(result.to_string());
    }
    let answer = if parts.is_empty() {
        "Claude reported an error without details".to_string()
    } else {
        parts.join(": ")
    };
    (answer, true)
}

#[derive(Default)]
pub(crate) struct ClaudeStreamTraceState {
    pub(crate) visible_assistant_text: String,
    pub(crate) current_message_text: String,
    pub(crate) last_message_id: Option<String>,
    seen_tool_uses: HashSet<String>,
    seen_tool_results: HashSet<String>,
    /// Bash commands that create pull requests, by tool use id, until their result.
    pull_request_commands: HashMap<String, String>,
    /// The plan outlives a turn, so the reporter does too (`next_turn`).
    activity: ChannelActivityReporter,
}

impl ClaudeStreamTraceState {
    /// A fresh turn's trace state that keeps what the plan already reported.
    pub(crate) fn next_turn(&mut self) {
        let activity = std::mem::take(&mut self.activity);
        *self = Self {
            activity,
            ..Self::default()
        };
    }

    /// Hand the plan reporter to another turn's state (a self-started turn).
    pub(crate) fn take_activity(&mut self) -> ChannelActivityReporter {
        std::mem::take(&mut self.activity)
    }

    pub(crate) fn with_activity(activity: ChannelActivityReporter) -> Self {
        Self {
            activity,
            ..Self::default()
        }
    }
}

/// The text a tool result carries: a string, or text blocks.
fn claude_tool_result_text(result: &Value) -> String {
    match result.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// Feed the plan reporter from one stream event and publish what it produced
/// (docs/design/conversation-activity.md §3.2).
fn observe_claude_activity(
    relay: &agent_instance_connection::AgentInstanceConnectionClient,
    channel_id: &str,
    value: &Value,
    state: &mut ClaudeStreamTraceState,
) {
    let now = Instant::now();
    match value.get("type").and_then(Value::as_str) {
        Some("assistant") => {
            for tool in claude_tool_use_blocks(value) {
                let input = tool.get("input").cloned().unwrap_or(Value::Null);
                match claude_tool_name(&tool).as_deref() {
                    Some("TodoWrite") => {
                        if let Some(steps) = claude_todo_steps(&input) {
                            let effects = state.activity.observe_plan(steps, now);
                            publish_effects(relay, channel_id, effects);
                        }
                    }
                    Some("Bash") => {
                        if let Some(command) = input.get("command").and_then(Value::as_str)
                            && creates_pull_request(command)
                        {
                            state
                                .pull_request_commands
                                .insert(claude_tool_item_key(&tool), command.to_string());
                        }
                    }
                    _ => {}
                }
            }
        }
        Some("user") => {
            for result in claude_tool_result_blocks(value) {
                let Some(command) = state
                    .pull_request_commands
                    .remove(&claude_tool_item_key(&result))
                else {
                    continue;
                };
                for activity in state
                    .activity
                    .observe_command_output(&command, &claude_tool_result_text(&result))
                {
                    publish_channel_activity(relay, channel_id, activity);
                }
            }
        }
        Some("result") => {
            for activity in state.activity.flush(now) {
                publish_channel_activity(relay, channel_id, activity);
            }
            if let Some(intent) = state.activity.turn_ended() {
                publish_intent(relay, intent);
            }
        }
        _ => {}
    }
}

pub(crate) async fn publish_claude_stream_trace(
    relay: &Arc<agent_instance_connection::AgentInstanceConnectionClient>,
    channel_id: &str,
    agent: &protocol::SerializedAgent,
    value: &Value,
    state: &mut ClaudeStreamTraceState,
) {
    observe_claude_activity(relay, channel_id, value, state);
    if let Some(payload) = claude_runtime_notice_payload(value) {
        send_llm_trace_with_source(
            relay,
            channel_id,
            "runtime_event",
            "claude_code",
            agent,
            None,
            None,
            payload,
        )
        .await;
        return;
    }
    match value.get("type").and_then(Value::as_str) {
        Some("assistant") => {
            let message_id = claude_message_id(value);
            let text = claude_assistant_text(value);
            let delta = claude_assistant_delta_for_message(state, message_id.as_deref(), &text);
            if !delta.is_empty() {
                send_llm_trace_with_source(
                    relay,
                    channel_id,
                    "assistant_delta",
                    "claude_code",
                    agent,
                    None,
                    extract_llm_model(value),
                    serde_json::json!({
                        "delta": delta,
                        "messageId": message_id,
                    }),
                )
                .await;
            }
            for tool in claude_tool_use_blocks(value) {
                let key = claude_tool_item_key(&tool);
                if !state.seen_tool_uses.insert(key.clone()) {
                    continue;
                }
                send_llm_trace_with_source(
                    relay,
                    channel_id,
                    "tool_call_started",
                    "claude_code",
                    agent,
                    None,
                    extract_llm_model(value),
                    serde_json::json!({
                        "item": tool,
                        "sourceMethod": "stream-json/assistant",
                    }),
                )
                .await;
            }
        }
        Some("user") => {
            for tool_result in claude_tool_result_blocks(value) {
                let key = claude_tool_item_key(&tool_result);
                if !state.seen_tool_results.insert(key) {
                    continue;
                }
                send_llm_trace_with_source(
                    relay,
                    channel_id,
                    "tool_result",
                    "claude_code",
                    agent,
                    None,
                    extract_llm_model(value),
                    serde_json::json!({
                        "item": tool_result,
                        "sourceMethod": "stream-json/user",
                    }),
                )
                .await;
            }
        }
        Some("system") => {
            // Claude Code emits assorted `system` events (init, compact_boundary,
            // ...). Only the once-per-turn `init` event is a meaningful turn marker;
            // other subtypes would otherwise be mislabeled and add noise.
            if value.get("subtype").and_then(Value::as_str) != Some("init") {
                return;
            }
            let model = extract_llm_model(value);
            let summary = match model.as_deref() {
                Some(model) => format!("Claude session started · {model}"),
                None => "Claude session started".to_string(),
            };
            send_llm_trace_with_source(
                relay,
                channel_id,
                "runtime_event",
                "claude_code",
                agent,
                None,
                model,
                serde_json::json!({
                    "category": "turn",
                    "status": "started",
                    "summary": summary,
                    "details": claude_init_details(value),
                }),
            )
            .await;
        }
        _ => {}
    }
}

#[cfg(test)]
mod background_task_tests {
    use super::ClaudeBackgroundTasks;
    use serde_json::json;

    fn event(subtype: &str, task_id: &str) -> serde_json::Value {
        json!({"type": "system", "subtype": subtype, "task_id": task_id, "description": "wait for CI", "status": "completed"})
    }

    fn update(task_id: &str, status: &str) -> serde_json::Value {
        json!({"type": "system", "subtype": "task_updated", "task_id": task_id, "patch": {"status": status}})
    }

    #[test]
    fn only_an_ending_status_closes_a_task() {
        let mut tasks = ClaudeBackgroundTasks::default();
        tasks.observe(&event("task_started", "b1"));
        // Still running or paused: open.
        assert_eq!(tasks.observe(&update("b1", "running")), None);
        assert_eq!(tasks.observe(&update("b1", "paused")), None);
        assert_eq!(
            tasks.observe(
                &json!({"type": "system", "subtype": "task_updated", "task_id": "b1", "patch": {}})
            ),
            None
        );
        let mut unknown = event("task_notification", "b1");
        unknown["status"] = json!("weird");
        assert_eq!(tasks.observe(&unknown), None);
        // An update that ends it closes it even with no notification.
        assert_eq!(tasks.observe(&update("b1", "killed")), Some(0));
        tasks.observe(&event("task_started", "b2"));
        assert_eq!(tasks.observe(&update("b2", "failed")), Some(0));
        // A later notification for the same task changes nothing.
        assert_eq!(tasks.observe(&event("task_notification", "b2")), None);
    }

    #[test]
    fn a_task_counts_from_its_start_until_its_notification() {
        let mut tasks = ClaudeBackgroundTasks::default();
        assert_eq!(tasks.observe(&event("task_started", "b1")), Some(1));
        // A repeated start changes nothing.
        assert_eq!(tasks.observe(&event("task_started", "b1")), None);
        assert_eq!(tasks.observe(&event("task_started", "b2")), Some(2));
        assert_eq!(tasks.open_descriptions(), ["wait for CI", "wait for CI"]);
        assert_eq!(tasks.observe(&event("task_notification", "b1")), Some(1));
        // A repeated or unknown notification changes nothing.
        assert_eq!(tasks.observe(&event("task_notification", "b1")), None);
        assert_eq!(tasks.observe(&event("task_notification", "zz")), None);
        assert_eq!(tasks.observe(&event("task_notification", "b2")), Some(0));
    }

    #[test]
    fn other_frames_are_not_task_events() {
        let mut tasks = ClaudeBackgroundTasks::default();
        assert_eq!(
            tasks.observe(&json!({"type": "system", "subtype": "init"})),
            None
        );
        assert_eq!(
            tasks.observe(&json!({"type": "assistant", "task_id": "b1"})),
            None
        );
        assert_eq!(
            tasks.observe(&json!({"type": "system", "subtype": "task_updated", "task_id": "b1"})),
            None
        );
        assert_eq!(tasks.count(), 0);
    }
}

#[cfg(test)]
mod pending_task_tests {
    use super::*;

    #[test]
    fn watch_and_pending_updates_keep_work_open_until_terminal() {
        for status in ["pending", "running", "paused", "watching"] {
            let mut tasks = ClaudeBackgroundTasks::default();
            let update = serde_json::json!({"type":"system", "subtype":"task_updated",
                "task_id":"watch", "patch":{"status":status}});
            assert_eq!(tasks.observe(&update), Some(1));
            assert_eq!(tasks.observe(&update), None);
            assert_eq!(tasks.count(), 1);
            for terminal in ["completed", "failed", "stopped", "killed"] {
                tasks.observe(&update);
                let end = serde_json::json!({"type":"system", "subtype":"task_updated",
                    "task_id":"watch", "patch":{"status":terminal}});
                assert_eq!(tasks.observe(&end), Some(0));
                assert_eq!(tasks.observe(&end), None);
            }
        }
    }
}
