// One Claude turn: resume-session bookkeeping, the model catalog and the
// control requests used to switch model, interrupt, and probe liveness.

use colored::Colorize;

use std::collections::VecDeque;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use serde_json::Value;
use tokio::sync::mpsc;

use crate::runtime_agent_goal_status::claude_goal_status_from_result_text;
use crate::runtime_agent_goal_status::goal_status_represents_absence;
use crate::runtime_claude_stream_session::ClaudeStreamSession;
use crate::runtime_claude_stream_session::ClaudeTurnStatus;
use crate::{
    GoalCommand, ImageBlockShape, LocalImageFiles, PresencePatch, agent_instance_connection,
    await_turn_with_events, clean_run_effort, clean_run_model, config, error,
    event_requests_active_turn_interrupt_with_replay, materialize_local_image_files,
    merge_llm_usage, prompt_content_blocks, protocol, read_claude_oauth_rate_limit_usage,
    reassert_busy_on_reconnect, resume_session_path, send_llm_trace_with_source, send_presence,
    trace_attachment_summaries,
};

/// Prefixed to the turn after an interrupt. Claude answers the cancelled tool
/// call with its human-refusal text, which the agent would otherwise misreport.
pub(crate) const CLAUDE_INTERRUPTED_TURN_NOTICE: &str = "[xMatrix] Your previous turn was interrupted because a newer channel message or a model/effort switch arrived. If a tool call from that turn was reported as \"The user doesn't want to proceed with this tool use\" or \"Request interrupted by user\", xMatrix cancelled it; no person rejected it. The command may have partly run: check its side effects before retrying or reporting it.";

#[allow(clippy::too_many_arguments)]
pub(crate) async fn run_claude_stream_turn(
    session: &mut ClaudeStreamSession,
    prompt: String,
    attachments: Option<Vec<protocol::ChannelAttachment>>,
    local_image_paths: Option<Vec<PathBuf>>,
    channel_id: String,
    sources: Option<&[crate::InboundChannelMessage]>,
    initial_source: Option<&protocol::AgentRuntimeMessageSource>,
    relay: &Arc<agent_instance_connection::AgentInstanceConnectionClient>,
    agent: &protocol::SerializedAgent,
    allow_empty_completion: bool,
    interrupt_history_replay: bool,
    goal_command: Option<GoalCommand>,
    event_rx: &mut mpsc::UnboundedReceiver<agent_instance_connection::AgentInstanceConnectionEvent>,
    pending_events: &mut VecDeque<agent_instance_connection::AgentInstanceConnectionEvent>,
) -> bool {
    let sources = sources.unwrap_or_default();
    let mut execution =
        if let Some(source) = initial_source.filter(|source| source.channel_id == channel_id) {
            session.runtime_state.begin_message_turn(
                Some(&channel_id),
                Some(&source.message_id),
                1,
                vec![source.clone()],
            )
        } else {
            session.runtime_state.begin_message_turn(
                Some(&channel_id),
                sources.first().map(|source| source.message_id.as_str()),
                sources.len(),
                crate::inbound_execution_sources(sources),
            )
        };
    // A `/goal` turn must stay a bare slash command; the notice waits for the
    // next message turn.
    let prompt = if goal_command.is_none() && std::mem::take(&mut session.previous_turn_interrupted)
    {
        format!("{CLAUDE_INTERRUPTED_TURN_NOTICE}\n\n{prompt}")
    } else {
        prompt
    };
    let prompt = match session
        .runtime_state
        .final_reply_instruction(Some(&channel_id))
    {
        Some(instruction) => format!("{prompt}\n\n{instruction}"),
        None => prompt,
    };
    crate::write_current_run_status("turn_running", false, None);
    let mut latest_usage = read_claude_oauth_rate_limit_usage(false).await;
    // Caller-provided paths are borrowed: the caller owns those files and
    // keeps them past this turn, because the prompt text cites them. Only
    // files materialized here are owned, and removed when the turn ends.
    let mut owned_image_files = LocalImageFiles::empty();
    let image_paths = match local_image_paths {
        Some(paths) if claude_turn_image_paths_usable(attachments.as_deref(), &paths) => paths,
        provided => {
            if provided.is_some() {
                eprintln!(
                    "{} Claude channel image files for this turn are missing; materializing them again",
                    "⚠".yellow().bold()
                );
            }
            match materialize_local_image_files(attachments.as_deref(), Some(relay.as_ref())).await
            {
                Ok(files) => owned_image_files = files,
                Err(err) => {
                    eprintln!(
                        "{} Failed to materialize Claude channel images: {err}",
                        "⚠".yellow().bold()
                    );
                }
            }
            owned_image_files.image_paths().to_vec()
        }
    };
    let content_blocks = prompt_content_blocks(
        &prompt,
        attachments.as_deref(),
        Some(&image_paths),
        ImageBlockShape::Anthropic,
    );
    send_presence(
        relay,
        Some("busy"),
        PresencePatch::presentation(session.presentation().snapshot(latest_usage.clone()))
            .goal(session.goals().current().cloned())
            .runtime_state(None),
    );
    send_llm_trace_with_source(
        relay,
        &channel_id,
        "turn_started",
        "claude_code",
        agent,
        latest_usage.clone(),
        None,
        serde_json::json!({
            "input": prompt,
            "attachments": trace_attachment_summaries(attachments.as_deref()),
        }),
    )
    .await;

    let outcome = {
        let interrupter = session.interrupter();
        let content_blocks = match content_blocks {
            Ok(blocks) => blocks,
            Err(err) => {
                eprintln!(
                    "{} Claude content block build failed: {err}; falling back to text-only turn",
                    "⚠".yellow().bold()
                );
                vec![serde_json::json!({
                    "type": "text",
                    "text": prompt,
                })]
            }
        };
        let runtime_state = session.runtime_state.clone();
        let turn = session.submit_turn(&prompt, content_blocks, &channel_id);
        await_turn_with_events(turn, event_rx, pending_events, async |event| {
            if reassert_busy_on_reconnect(event, Some(relay), Some(&channel_id), || {
                PresencePatch::usage(latest_usage.clone())
                    .runtime_state(Some(runtime_state.snapshot()))
            }) {
                return true;
            }
            if event_requests_active_turn_interrupt_with_replay(
                event,
                Some(&channel_id),
                Some(agent.id.as_str()),
                interrupt_history_replay,
            ) && let Err(err) = interrupter.interrupt_active_turn().await
            {
                eprintln!(
                    "{} claude stream interrupt failed: {err}",
                    "⚠".yellow().bold()
                );
            }
            false
        })
        .await
    };

    let turn_completed = matches!(&outcome.status, ClaudeTurnStatus::Completed);
    let execution_state = match &outcome.status {
        ClaudeTurnStatus::Completed => "completed",
        ClaudeTurnStatus::Failed => "failed",
        ClaudeTurnStatus::TransportFailed => "unknown",
        ClaudeTurnStatus::Interrupted => "interrupted",
    };
    // This wrapper interrupted the turn because a newer channel message
    // superseded it; that message is the next turn. It closes as cancelled,
    // not failed: the channel gets no "could not complete" notice, and
    // Claude's abort diagnostics are not an error message.
    let turn_interrupted = matches!(&outcome.status, ClaudeTurnStatus::Interrupted);
    session.previous_turn_interrupted |= turn_interrupted;
    session.last_turn_interrupted = turn_interrupted;
    execution.finish_as(execution_state);
    let (body, turn_usage) = match outcome.status {
        ClaudeTurnStatus::Completed if !outcome.answer.trim().is_empty() => {
            (outcome.answer, outcome.usage)
        }
        ClaudeTurnStatus::Completed if allow_empty_completion => (String::new(), outcome.usage),
        ClaudeTurnStatus::Completed => (
            "Claude returned an empty response.".to_string(),
            outcome.usage,
        ),
        // The persistent process died mid-turn; `answer` already carries a
        // human-readable explanation (interrupted / indeterminate). Surface it
        // verbatim — the session resumes from the saved id on the next turn.
        ClaudeTurnStatus::Failed | ClaudeTurnStatus::TransportFailed => {
            (outcome.answer, outcome.usage)
        }
        ClaudeTurnStatus::Interrupted => (String::new(), outcome.usage),
    };
    if turn_interrupted {
        crate::write_current_run_status("turn_interrupted", false, None);
    } else if !turn_completed {
        let detail = if body.trim().is_empty() {
            "Claude stream turn failed".to_string()
        } else {
            body.clone()
        };
        crate::report_turn_failure_with_usage_limit(
            relay.as_ref(),
            Some(&channel_id),
            agent,
            &detail,
            execution_state == "unknown",
            outcome.usage_limit.clone(),
        );
    } else {
        crate::write_current_run_status("turn_completed", true, None);
    }

    latest_usage = merge_llm_usage(latest_usage, turn_usage);
    // Force a refresh after the turn so presence reflects post-turn windows when available.
    latest_usage = merge_llm_usage(latest_usage, read_claude_oauth_rate_limit_usage(true).await);

    if turn_completed && !body.trim().is_empty() {
        eprintln!("{body}");
    }
    send_llm_trace_with_source(
        relay,
        &channel_id,
        if turn_completed {
            "turn_completed"
        } else if turn_interrupted {
            "turn_cancelled"
        } else {
            "turn_failed"
        },
        "claude_code",
        agent,
        latest_usage.clone(),
        None,
        if turn_interrupted {
            serde_json::json!({
                "reason": "Interrupted by a newer channel message or model switch",
                "executionState": execution_state,
            })
        } else {
            serde_json::json!({ "text": body, "executionState": execution_state })
        },
    )
    .await;
    // Pick up whatever the turn wrote to the transcript — the goal the
    // evaluator recorded and the reasoning effort the model ran at — then,
    // for the control commands that never reach the evaluator, the ack text
    // of this goal turn.
    let mut goal_changed = session.poll_transcript();
    if matches!(goal_command, Some(GoalCommand::Clear)) && turn_completed {
        if claude_goal_status_from_result_text(&body).is_some_and(|goal| {
            goal.status
                .as_deref()
                .is_some_and(|status| status.eq_ignore_ascii_case("cleared"))
                || goal_status_represents_absence(&goal)
        }) {
            session.goals_mut().clear();
            goal_changed = true;
        }
    } else if matches!(goal_command, Some(GoalCommand::Get))
        && let Some(goal) = claude_goal_status_from_result_text(&body)
    {
        if goal_status_represents_absence(&goal) {
            session.goals_mut().clear();
        } else {
            session.goals_mut().apply(goal);
        }
        goal_changed = true;
    }
    if goal_changed {
        crate::publish_bound_goal_state(session.goals().current());
        send_llm_trace_with_source(
            relay,
            &channel_id,
            "goal_updated",
            "claude_code",
            agent,
            latest_usage.clone(),
            None,
            serde_json::json!({ "claudeGoal": session.goals().current() }),
        )
        .await;
    }
    // Report `idle` (not `online`) at turn end, which is also what the presence
    // heartbeat reports between turns — the two must not disagree.
    //
    // This used to cite a hub-side `flushBusyAgentBacklog` that released queued
    // channel messages on the busy->idle edge. No such function exists anywhere
    // in the repo any more, and nothing in the hub keys delivery off that edge,
    // so that rationale is gone rather than merely renamed.
    // Background tasks the turn left running are still waited on
    // (docs/design/agent-status.md); without them the report omits the state.
    send_presence(
        relay,
        Some("idle"),
        PresencePatch::presentation(session.presentation().snapshot(latest_usage))
            .goal(session.goals().current().cloned())
            .runtime_state(session.runtime_state.waiting_snapshot()),
    );
    turn_completed
}

/// Whether caller-provided image files can back this turn's image blocks.
/// Content blocks pair the turn's image attachments with the paths by
/// position, so the paths must be exactly this turn's images, one per image
/// attachment, and still on disk. Anything else (a stale list, a file removed
/// since it was written) is re-materialized from the attachments instead of
/// silently dropping every image.
pub(crate) fn claude_turn_image_paths_usable(
    attachments: Option<&[protocol::ChannelAttachment]>,
    paths: &[PathBuf],
) -> bool {
    let images = attachments
        .unwrap_or_default()
        .iter()
        .filter(|attachment| attachment.kind == "image")
        .count();
    images == paths.len() && paths.iter().all(|path| path.is_file())
}

pub(crate) fn claude_resume_session_path(key: &str) -> PathBuf {
    resume_session_path("claude-resume", key)
}

/// Where a Claude resume session transcript was found relative to the working
/// directory we are about to launch in.
pub(crate) enum ResumeSessionLocation {
    /// A transcript for the session exists and its recorded cwd matches ours.
    InCwd,
    /// A transcript exists but under a *different* working directory.
    Elsewhere(String),
    /// No transcript for this session id exists anywhere in the store.
    Missing,
}

/// Normalize a path string for cross-platform comparison: unify separators and
/// drop a trailing slash. (Claude records cwd as the literal launch path.)
pub(crate) fn normalize_cwd_for_compare(path: &str) -> String {
    path.trim()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string()
}

/// Read the `cwd` recorded inside a Claude transcript file. The first few lines
/// may be queue-operation markers without a cwd, so scan a bounded prefix.
pub(crate) fn claude_transcript_cwd(path: &Path) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    let reader = std::io::BufReader::new(file);
    for line in std::io::BufRead::lines(reader)
        .map_while(Result::ok)
        .take(200)
    {
        if !line.contains("\"cwd\"") {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(&line)
            && let Some(cwd) = value.get("cwd").and_then(Value::as_str)
        {
            let cwd = cwd.trim();
            if !cwd.is_empty() {
                return Some(cwd.to_string());
            }
        }
    }
    None
}

/// Whether a child exit status reports death by signal (an external kill)
/// rather than a normal exit. Windows has no signal exits, so only Unix can
/// report true; crash exit codes still take the normal recovery path.
pub(crate) fn exit_status_signal_terminated(status: std::process::ExitStatus) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        status.signal().is_some()
    }
    #[cfg(not(unix))]
    {
        let _ = status;
        false
    }
}

/// Decide whether a Claude `--resume` session id belongs to `cwd`. Claude looks
/// up `--resume <id>` in the transcript store keyed by the *current* working
/// directory; resuming an id whose transcript lives under another cwd silently
/// drags in an unrelated conversation (or fails to find it). We verify ownership
/// by locating `<id>.jsonl` under the projects store and comparing its recorded
/// cwd to ours.
pub(crate) fn locate_claude_resume_session(resume_id: &str, cwd: &Path) -> ResumeSessionLocation {
    let Some(root) = config::claude_projects_dir() else {
        return ResumeSessionLocation::Missing;
    };
    let file_name = format!("{resume_id}.jsonl");
    let Ok(entries) = std::fs::read_dir(&root) else {
        return ResumeSessionLocation::Missing;
    };
    let want = normalize_cwd_for_compare(&cwd.to_string_lossy());
    let mut found_elsewhere: Option<String> = None;
    for entry in entries.flatten() {
        let candidate = entry.path().join(&file_name);
        if !candidate.is_file() {
            continue;
        }
        match claude_transcript_cwd(&candidate) {
            Some(session_cwd) => {
                if normalize_cwd_for_compare(&session_cwd).eq_ignore_ascii_case(&want) {
                    return ResumeSessionLocation::InCwd;
                }
                found_elsewhere = Some(session_cwd);
            }
            // No cwd field recorded yet — fall back to the project dir as the hint.
            None => found_elsewhere = Some(entry.path().display().to_string()),
        }
    }
    match found_elsewhere {
        Some(other) => ResumeSessionLocation::Elsewhere(other),
        None => ResumeSessionLocation::Missing,
    }
}

/// How to continue once a reborn is refused: a new Instance, in the tag syntax
/// that replaced the retired `:new` / `:once` launch suffixes.
const CLAUDE_REBORN_NEW_INSTANCE_HINT: &str = "Start a new Instance instead, for example \
     `@claude repo:<owner/repo>` or `@claude pwd:\"<registered directory>\"`.";

/// Why a Claude reborn cannot resume `resume_id` from `cwd`, or `None` when the
/// session's transcript was recorded in exactly this directory. Claude resolves
/// `--resume` per cwd, so a session recorded elsewhere would splice in an
/// unrelated conversation (or none). The daemon asks this before it spawns and
/// the stream session asks it again before `--resume`; neither loosens it.
pub(crate) fn claude_reborn_resume_refusal(resume_id: &str, cwd: &Path) -> Option<String> {
    match locate_claude_resume_session(resume_id, cwd) {
        ResumeSessionLocation::InCwd => None,
        ResumeSessionLocation::Elsewhere(other) => {
            // A pooled checkout is only this Instance's while its slot still
            // binds the session; once the pool gives it to another session
            // (or evicts it) the conversation has nowhere left to resume.
            let cause = if crate::repo_pool::default_repo_pools_root()
                .is_ok_and(|root| Path::new(&other).starts_with(root))
            {
                "That repository-pool checkout was reclaimed for another session, so the \
                 conversation has nowhere left to resume."
            } else {
                "Its working directory has since changed."
            };
            Some(format!(
                "Refusing to reborn: this Instance's conversation (Claude session {resume_id}) \
                 was recorded in {other}, but it would now start in {}. {cause} Resuming here \
                 would splice in an unrelated conversation. {CLAUDE_REBORN_NEW_INSTANCE_HINT}",
                cwd.display()
            ))
        }
        ResumeSessionLocation::Missing => Some(format!(
            "Refusing to reborn: no Claude transcript for session {resume_id} exists under the \
             projects store for {}. {CLAUDE_REBORN_NEW_INSTANCE_HINT}",
            cwd.display()
        )),
    }
}

/// Remove the persisted resume id when it still names `session_id`, so a later
/// `:reborn` cannot resume a retired session. A different id on disk belongs to
/// a newer session and stays.
pub(crate) fn clear_claude_resume_session_id(key: Option<&str>, session_id: Option<&str>) {
    let Some(session_id) = session_id else {
        return;
    };
    if load_claude_resume_session_id(key).as_deref() != Some(session_id) {
        return;
    }
    if let Some(key) = key.map(str::trim).filter(|value| !value.is_empty()) {
        let _ = std::fs::remove_file(claude_resume_session_path(key));
    }
}

pub(crate) fn load_claude_resume_session_id(key: Option<&str>) -> Option<String> {
    crate::load_resume_session_id("claude-resume", key)
}

pub(crate) fn save_claude_resume_session_id(
    key: Option<&str>,
    session_id: Option<&str>,
) -> error::Result<()> {
    crate::save_resume_session_id("claude-resume", "Claude", key, session_id)
}

/// Claude Code has no runtime API for enumerating models (`supported_models`
/// is not a recognized control request as of 2.1.206), so the catalog is the
/// stable set of model aliases the CLI resolves itself — accepted both by
/// `--model` and by the `set_model` control request (verified empirically).
/// Aliases always track the latest build of each tier, so this catalog does
/// not go stale when new model ids ship.
pub(crate) fn claude_model_catalog() -> Vec<protocol::AgentModelInfo> {
    fn entry(id: &str, display_name: &str, description: &str) -> protocol::AgentModelInfo {
        protocol::AgentModelInfo {
            id: id.to_string(),
            model: id.to_string(),
            display_name: Some(display_name.to_string()),
            description: Some(description.to_string()),
            hidden: None,
            is_default: None,
            // Claude caps effort per model, but nothing in the stream-json
            // transport reports that cap, so every alias advertises the same
            // levels rather than a guessed per-model subset.
            default_reasoning_effort: None,
            supported_reasoning_efforts: Some(claude_effort_catalog()),
            input_modalities: None,
            supports_personality: None,
            upgrade: None,
        }
    }
    let mut default = entry(
        "default",
        "Default",
        "The account's configured default model",
    );
    default.is_default = Some(true);
    vec![
        default,
        entry("fable", "Fable", "Latest Fable model"),
        entry("opus", "Opus", "Latest Opus model"),
        entry("sonnet", "Sonnet", "Latest Sonnet model"),
        entry(
            "sonnet[1m]",
            "Sonnet 1M",
            "Latest Sonnet model with the 1M-token context window",
        ),
        entry("haiku", "Haiku", "Latest Haiku model"),
        entry(
            "opusplan",
            "Opus Plan",
            "Opus for plan mode, Sonnet for execution",
        ),
    ]
}

/// The reasoning-effort levels Claude Code accepts, with the CLI's own
/// descriptions. Both entry points were checked against 2.1.273: `--effort`
/// takes each of these at launch, and `/effort <bad>` answers
/// `Valid options are: low, medium, high, xhigh, max, ultracode, auto`.
///
/// `ultracode` and `auto` are deliberately left out. `ultracode` is refused
/// whenever a launch `--effort` pin is in force and needs dynamic workflows
/// enabled, and `auto` (return to the model default) has no `--effort`
/// spelling, so a selection would not survive the next respawn. Offering
/// either would advertise a switch that can silently not stick.
pub(crate) fn claude_effort_catalog() -> Vec<protocol::AgentModelReasoningEffort> {
    fn level(reasoning_effort: &str, description: &str) -> protocol::AgentModelReasoningEffort {
        protocol::AgentModelReasoningEffort {
            reasoning_effort: reasoning_effort.to_string(),
            description: Some(description.to_string()),
        }
    }
    vec![
        level("low", "Quick, straightforward implementation"),
        level("medium", "Balanced approach with standard testing"),
        level(
            "high",
            "Comprehensive implementation with extensive testing",
        ),
        level("xhigh", "Extended reasoning with thorough analysis"),
        level("max", "Maximum capability with deepest reasoning"),
    ]
}

/// The reasoning effort in force at launch, if anything pinned one.
///
/// Claude never reports its live effort back: `system/init` has no effort
/// field and `apply_flag_settings` answers with a bare `success`, so what this
/// runtime itself pinned is the only effort it can honestly report. `None`
/// means the account/model default is in force and no chip is shown, rather
/// than a guessed vendor default.
///
/// `CLAUDE_CODE_EFFORT_LEVEL` is read first because the CLI says it outranks
/// the flag ("CLAUDE_CODE_EFFORT_LEVEL overrides effort for this session").
pub(crate) fn claude_initial_effort_from_args(cmd_args: &[String]) -> Option<String> {
    if let Some(effort) = std::env::var("CLAUDE_CODE_EFFORT_LEVEL")
        .ok()
        .as_deref()
        .and_then(clean_run_effort)
    {
        return Some(effort);
    }
    let mut iter = cmd_args.iter();
    while let Some(arg) = iter.next() {
        if arg == "--effort" {
            return iter.next().map(String::as_str).and_then(clean_run_effort);
        }
        if let Some(value) = arg.strip_prefix("--effort=") {
            return clean_run_effort(value);
        }
    }
    None
}

/// The launcher's own args may already pin a model (`--model sonnet` /
/// `--model=sonnet`); use it to seed the reported model before the first
/// stream event reveals the resolved id.
pub(crate) fn claude_initial_model_from_args(cmd_args: &[String]) -> Option<String> {
    let mut iter = cmd_args.iter();
    while let Some(arg) = iter.next() {
        if arg == "--model" {
            return iter.next().map(String::as_str).and_then(clean_run_model);
        }
        if let Some(value) = arg.strip_prefix("--model=") {
            return clean_run_model(value);
        }
    }
    None
}

/// One line of stream-json stdin asking the live process to change its
/// reasoning effort. `apply_flag_settings` is the only runtime control Claude
/// exposes for effort (2.1.273, verified against a live stream-json session).
///
/// Unlike `set_model` it is **not** a validator: an unrecognized level is
/// answered `success` just like a real one, so the catalog check in
/// `ClaudeStreamSession::select_effort` is the only thing standing between a
/// typo and a silently ignored switch.
pub(crate) fn claude_apply_effort_control_request(request_id: &str, effort: &str) -> Value {
    serde_json::json!({
        "type": "control_request",
        "request_id": request_id,
        "request": {
            "subtype": "apply_flag_settings",
            "settings": { "effortLevel": effort },
        },
    })
}

/// One line of stream-json stdin asking the live process to switch models.
/// Claude validates the value itself and answers with a `control_response`
/// keyed by `request_id`.
pub(crate) fn claude_set_model_control_request(request_id: &str, model: &str) -> Value {
    serde_json::json!({
        "type": "control_request",
        "request_id": request_id,
        "request": { "subtype": "set_model", "model": model },
    })
}

pub(crate) fn claude_interrupt_control_request(request_id: &str) -> Value {
    serde_json::json!({
        "type": "control_request",
        "request_id": request_id,
        "request": {
            "subtype": "interrupt",
        },
    })
}

/// Side-effect-free watchdog liveness probe. Unsupported subtypes still get an
/// immediate error response from a healthy Claude event loop.
pub(crate) fn claude_liveness_probe_control_request(request_id: &str) -> Value {
    serde_json::json!({
        "type": "control_request",
        "request_id": request_id,
        "request": {
            "subtype": "status",
        },
    })
}

/// The answer to a `control_request` the CLI sends *us* on stdout, matching
/// what the official Agent SDK sends when the host registered no handler
/// (`@anthropic-ai/claude-agent-sdk` 0.3.281). Unanswered, such a request
/// parks the turn: the CLI keeps answering the liveness probe, so the
/// watchdog never recovers it.
///
/// - `elicitation` (an MCP server asking for input) is declined.
/// - `request_user_dialog` is left unanswered: the protocol forbids answering
///   a dialog kind the host never declared, and the CLI cancels it itself.
/// - Anything else gets the SDK's `Unsupported control request subtype` error.
pub(crate) fn claude_inbound_control_response(value: &Value) -> Option<Value> {
    if value.get("type").and_then(Value::as_str) != Some("control_request") {
        return None;
    }
    let request_id = value.get("request_id").and_then(Value::as_str)?;
    let subtype = value
        .get("request")
        .and_then(|request| request.get("subtype"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let response = match subtype {
        "request_user_dialog" => return None,
        "elicitation" => serde_json::json!({
            "subtype": "success",
            "request_id": request_id,
            "response": { "action": "decline" },
        }),
        _ => serde_json::json!({
            "subtype": "error",
            "request_id": request_id,
            "error": format!("Unsupported control request subtype: {subtype}"),
        }),
    };
    Some(serde_json::json!({ "type": "control_response", "response": response }))
}

/// Whether a `result` closes a turn the CLI started by itself rather than one
/// we submitted: Claude stamps `origin` (e.g. `{"kind":"task-notification"}`
/// when a background task finished) only on those (2.1.280, observed).
pub(crate) fn claude_result_is_cli_originated(result: &Value) -> bool {
    result
        .pointer("/origin/kind")
        .and_then(Value::as_str)
        .is_some_and(|kind| kind != "human")
}

/// Parses a stdout `control_response` line into its request id and outcome.
pub(crate) fn claude_control_response_outcome(
    value: &Value,
) -> Option<(String, Result<(), String>)> {
    if value.get("type").and_then(Value::as_str) != Some("control_response") {
        return None;
    }
    let response = value.get("response")?;
    let request_id = response
        .get("request_id")
        .and_then(Value::as_str)?
        .to_string();
    let outcome = match response.get("subtype").and_then(Value::as_str) {
        Some("success") => Ok(()),
        _ => Err(response
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Claude rejected the control request")
            .to_string()),
    };
    Some((request_id, outcome))
}
