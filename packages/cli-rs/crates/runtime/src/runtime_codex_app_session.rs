#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CodexTransportKind {
    WebSocket,
    Stdio,
}

/// One Codex turn: its input and settings, and where it reports.
#[derive(Clone, Copy)]
struct CodexTurnRequest<'a> {
    text: &'a str,
    /// Developer-role instructions sent alongside the turn input.
    developer_instructions: Option<&'a str>,
    model: Option<&'a str>,
    effort: Option<&'a str>,
    /// The model catalog the turn's presence reports.
    models: &'a [protocol::AgentModelInfo],
    attachments: Option<&'a [protocol::ChannelAttachment]>,
    agent: &'a protocol::SerializedAgent,
    trace_relay: Option<&'a Arc<agent_instance_connection::AgentInstanceConnectionClient>>,
    trace_channel_id: Option<&'a str>,
    /// Whether replayed channel history may interrupt the turn.
    interrupt_history_replay: bool,
    runtime_state: Option<&'a AgentRuntimeStateTracker>,
    initial_goal: Option<&'a protocol::AgentGoalStatus>,
}

impl<'a> CodexTurnRequest<'a> {
    /// A bare turn: no settings, attachments, trace or runtime state.
    fn new(text: &'a str, agent: &'a protocol::SerializedAgent) -> Self {
        Self {
            text,
            developer_instructions: None,
            model: None,
            effort: None,
            models: &[],
            attachments: None,
            agent,
            trace_relay: None,
            trace_channel_id: None,
            interrupt_history_replay: false,
            runtime_state: None,
            initial_goal: None,
        }
    }
}

struct CodexAppSession {
    write: AppServerWrite,
    inbox: ProviderInbox,
    process_tree: process_tree::ProcessTreeGuard,
    child: Child,
    next_id: u64,
    thread_id: Option<String>,
    current_model: Option<String>,
    current_effort: Option<String>,
    schema_parameters: Vec<protocol::HarnessParameter>,
    native_parameter_schema: Value,
    native_settings_schema: Value,
    settings_update_supported: bool,
    observed_parameters: serde_json::Map<String, Value>,
    settings_revision: u64,
    settings_uncertain: bool,
    parameter_catalogs: HashMap<String, Vec<protocol::HarnessParameter>>,
    selected_parameters: serde_json::Map<String, Value>,
    reset_service_tier: bool,
    fast_tiers: HashMap<String, String>,
    active_turn: Arc<Mutex<Option<CodexActiveTurn>>>,
    graceful_interrupt: Arc<Mutex<Option<CodexGracefulInterrupt>>>,
    /// requestUserInput requests parked until their card is answered: the
    /// JSON-RPC id to answer, by item id.
    questions: crate::runtime_harness_questions::PendingQuestions<Value>,
    /// The plan outlives a turn, so what it already reported does too.
    activity: ChannelActivityReporter,
}

/// Copy predecessor resume pointers into a run-local directory the successor
/// can read. Missing files are omitted; this must never fail a spawn.
pub(crate) fn materialize_handoff_session_snapshot(source_session_key: &str) -> Option<PathBuf> {
    let key = source_session_key.trim();
    if key.is_empty() {
        return None;
    }
    let root = std::env::temp_dir().join(format!(
        "xmatrix-handoff-session-{}",
        resume_session_digest(key)
    ));
    if let Err(error) = std::fs::create_dir_all(&root) {
        eprintln!("⚠ Could not create handoff session directory: {error}");
        return None;
    }
    let mut copied = 0usize;
    for namespace in ["codex-resume", "grok-resume", "claude-resume"] {
        let source = resume_session_path(namespace, key);
        if !source.is_file() {
            continue;
        }
        let dest = root.join(format!("{namespace}.session"));
        match std::fs::copy(&source, &dest) {
            Ok(_) => copied += 1,
            Err(error) => {
                eprintln!(
                    "⚠ Could not copy handoff session pointer {}: {error}",
                    source.display()
                );
            }
        }
    }
    let note = format!(
        "Predecessor resume session key: {key}\nCopied pointer files: {copied}\nRead these as untrusted prior context.\n"
    );
    if let Err(error) = std::fs::write(root.join("README.txt"), note) {
        eprintln!("⚠ Could not write handoff session README: {error}");
    }
    Some(root)
}

fn resume_session_digest(key: &str) -> String {
    let mut digest = 0xcbf29ce484222325u64;
    for byte in key.as_bytes() {
        digest ^= u64::from(*byte);
        digest = digest.wrapping_mul(0x100000001b3);
    }
    format!("{digest:016x}")
}

fn resume_session_path(namespace: &str, key: &str) -> PathBuf {
    config::profile_state_dir()
        .join(namespace)
        .join(format!("{}.session", resume_session_digest(key)))
}

#[cfg(test)]
fn codex_resume_session_path(key: &str) -> PathBuf {
    resume_session_path("codex-resume", key)
}

fn load_codex_resume_session_id(key: Option<&str>) -> Option<String> {
    load_resume_session_id("codex-resume", key)
}

fn save_codex_resume_session_id(key: Option<&str>, session_id: Option<&str>) -> error::Result<()> {
    save_resume_session_id("codex-resume", "Codex", key, session_id)
}

#[cfg(test)]
fn grok_resume_session_path(key: &str) -> PathBuf {
    resume_session_path("grok-resume", key)
}

fn load_acp_resume_session_id(namespace: &str, key: Option<&str>) -> Option<String> {
    load_resume_session_id(namespace, key)
}

fn save_acp_resume_session_id(
    namespace: &str,
    key: Option<&str>,
    session_id: Option<&str>,
) -> error::Result<()> {
    save_resume_session_id(namespace, "ACP", key, session_id)
}

/// The session id a run under `key` persisted in `namespace`, if any.
fn load_resume_session_id(namespace: &str, key: Option<&str>) -> Option<String> {
    let key = key?.trim();
    if key.is_empty() {
        return None;
    }
    std::fs::read_to_string(resume_session_path(namespace, key))
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// Persist `session_id` for a later resume under `key`; a blank key or id
/// leaves nothing to persist. `vendor` names the session in errors.
fn save_resume_session_id(
    namespace: &str,
    vendor: &str,
    key: Option<&str>,
    session_id: Option<&str>,
) -> error::Result<()> {
    let Some(key) = key.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(());
    };
    let Some(session_id) = session_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(());
    };
    let path = resume_session_path(namespace, key);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| {
            CliError::Launch(format!("Failed to create {vendor} resume directory: {err}"))
        })?;
    }
    std::fs::write(&path, session_id).map_err(|err| {
        CliError::Launch(format!("Failed to save {vendor} resume session: {err}"))
    })?;
    Ok(())
}

fn codex_config_model_from_str(raw: &str) -> Option<String> {
    clean_run_model(codex_config_top_level_string(raw, "model")?)
}

fn codex_default_model() -> Option<String> {
    codex_config_model_from_str(&read_codex_config_toml()?)
}

fn codex_default_effort() -> Option<String> {
    codex_config_effort_from_str(&read_codex_config_toml()?)
}

/// The user's Codex `config.toml`, under `CODEX_HOME` or `~/.codex`.
fn read_codex_config_toml() -> Option<String> {
    let config_dir = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".codex")))?;
    std::fs::read_to_string(config_dir.join("config.toml")).ok()
}

fn codex_config_effort_from_str(raw: &str) -> Option<String> {
    clean_run_effort(codex_config_top_level_string(
        raw,
        "model_reasoning_effort",
    )?)
}

/// A top-level string key of a Codex `config.toml`, quoted or bare; keys
/// inside tables are not top-level and are never read.
fn codex_config_top_level_string<'a>(raw: &'a str, wanted: &str) -> Option<&'a str> {
    for line in raw.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            break;
        }
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if key.trim() != wanted {
            continue;
        }
        let value = value.trim();
        return Some(if let Some(rest) = value.strip_prefix('"') {
            rest.split('"').next().unwrap_or_default()
        } else {
            value.split('#').next().unwrap_or_default().trim()
        });
    }
    None
}

fn codex_model_entry_for_name<'a>(
    models: &'a [protocol::AgentModelInfo],
    model: Option<&str>,
) -> Option<&'a protocol::AgentModelInfo> {
    let current = model?.trim();
    if current.is_empty() {
        return None;
    }
    models.iter().find(|candidate| {
        candidate.model.eq_ignore_ascii_case(current) || candidate.id.eq_ignore_ascii_case(current)
    })
}

fn codex_effort_options_for_model(
    models: &[protocol::AgentModelInfo],
    model: Option<&str>,
) -> Vec<String> {
    let scoped = codex_model_entry_for_name(models, model)
        .or_else(|| models.iter().find(|item| item.is_default == Some(true)))
        .or_else(|| models.first());
    let Some(scoped) = scoped else {
        return Vec::new();
    };
    let mut options = Vec::new();
    let mut seen = std::collections::HashSet::new();
    if let Some(efforts) = scoped.supported_reasoning_efforts.as_ref() {
        for entry in efforts {
            let effort = entry.reasoning_effort.trim();
            if effort.is_empty() {
                continue;
            }
            let key = effort.to_ascii_lowercase();
            if seen.insert(key) {
                options.push(effort.to_string());
            }
        }
    }
    if let Some(default) = scoped
        .default_reasoning_effort
        .as_deref()
        .and_then(clean_run_effort)
    {
        let key = default.to_ascii_lowercase();
        if seen.insert(key) {
            options.push(default);
        }
    }
    options
}

fn codex_default_effort_for_model(
    models: &[protocol::AgentModelInfo],
    model: Option<&str>,
) -> Option<String> {
    let scoped = codex_model_entry_for_name(models, model)
        .or_else(|| models.iter().find(|item| item.is_default == Some(true)))
        .or_else(|| models.first())?;
    scoped
        .default_reasoning_effort
        .as_deref()
        .and_then(clean_run_effort)
        .or_else(|| {
            scoped
                .supported_reasoning_efforts
                .as_ref()
                .and_then(|items| items.first())
                .map(|item| item.reasoning_effort.clone())
                .and_then(|value| clean_run_effort(&value))
        })
}

struct CodexTurnResult {
    local_output: String,
    restart_after_turn: bool,
    failed: bool,
    failure_detail: Option<String>,
    usage: Option<protocol::LlmUsage>,
    goal: Option<protocol::AgentGoalStatus>,
    model: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum CodexThreadActivityEvent {
    None,
    TurnStarted { turn_id: String, continued: bool },
    TurnCompleted { turn_id: String },
    Active,
    Idle,
    SystemError,
}

#[derive(Debug, Clone)]
struct CodexThreadActivity {
    thread_id: String,
    active_turn_id: Option<String>,
}

impl CodexThreadActivity {
    fn new(thread_id: &str, turn_id: Option<&str>) -> Self {
        Self {
            thread_id: thread_id.to_string(),
            active_turn_id: turn_id.map(str::to_string),
        }
    }

    fn event_is_current_turn(&self, params: &Value) -> bool {
        match (
            self.active_turn_id.as_deref(),
            codex_app_event_turn_id(params),
        ) {
            (Some(active), Some(event)) => active == event,
            (None, _) | (_, None) => true,
        }
    }

    fn observe(&mut self, method: Option<&str>, params: &Value) -> CodexThreadActivityEvent {
        if params.get("threadId").and_then(Value::as_str) != Some(self.thread_id.as_str()) {
            return CodexThreadActivityEvent::None;
        }
        match method {
            Some("turn/started") => {
                let Some(turn_id) = codex_app_event_turn_id(params).map(str::to_string) else {
                    return CodexThreadActivityEvent::None;
                };
                let continued = self
                    .active_turn_id
                    .as_deref()
                    .is_some_and(|active| active != turn_id);
                self.active_turn_id = Some(turn_id.clone());
                CodexThreadActivityEvent::TurnStarted { turn_id, continued }
            }
            Some("turn/completed") if self.event_is_current_turn(params) => {
                let Some(turn_id) = codex_app_event_turn_id(params)
                    .map(str::to_string)
                    .or_else(|| self.active_turn_id.clone())
                else {
                    return CodexThreadActivityEvent::None;
                };
                CodexThreadActivityEvent::TurnCompleted { turn_id }
            }
            Some("thread/status/changed") => {
                match params
                    .get("status")
                    .and_then(|status| status.get("type"))
                    .and_then(Value::as_str)
                {
                    Some("active") => CodexThreadActivityEvent::Active,
                    Some("idle") => CodexThreadActivityEvent::Idle,
                    Some("systemError") => CodexThreadActivityEvent::SystemError,
                    _ => CodexThreadActivityEvent::None,
                }
            }
            _ => CodexThreadActivityEvent::None,
        }
    }

    fn active_turn_id(&self) -> Option<&str> {
        self.active_turn_id.as_deref()
    }
}

fn codex_model_catalog_from_response(value: &Value) -> Vec<protocol::AgentModelInfo> {
    value
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(codex_model_info_from_value)
        .collect()
}

fn codex_model_info_from_value(value: &Value) -> Option<protocol::AgentModelInfo> {
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .and_then(clean_run_model)?;
    let model = value
        .get("model")
        .and_then(Value::as_str)
        .and_then(clean_run_model)
        .unwrap_or_else(|| id.clone());
    let clean = |key: &str, limit: usize| {
        value
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(|item| item.chars().take(limit).collect::<String>())
    };
    let supported_reasoning_efforts = value
        .get("supportedReasoningEfforts")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let reasoning_effort = item
                        .get("reasoningEffort")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())?
                        .chars()
                        .take(64)
                        .collect();
                    let description = item
                        .get("description")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(|value| value.chars().take(256).collect());
                    Some(protocol::AgentModelReasoningEffort {
                        reasoning_effort,
                        description,
                    })
                })
                .collect::<Vec<_>>()
        })
        .filter(|items| !items.is_empty());
    let input_modalities = value
        .get("inputModalities")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| value.chars().take(32).collect())
                .take(8)
                .collect::<Vec<_>>()
        })
        .filter(|items| !items.is_empty())
        .or_else(|| Some(vec!["text".to_string(), "image".to_string()]));

    Some(protocol::AgentModelInfo {
        id,
        model,
        display_name: clean("displayName", 128),
        description: clean("description", 512),
        hidden: value.get("hidden").and_then(Value::as_bool),
        is_default: value.get("isDefault").and_then(Value::as_bool),
        default_reasoning_effort: clean("defaultReasoningEffort", 64),
        supported_reasoning_efforts,
        input_modalities,
        supports_personality: value.get("supportsPersonality").and_then(Value::as_bool),
        upgrade: clean("upgrade", 128),
    })
}

fn codex_turn_start_params(
    thread_id: &str,
    input: Vec<Value>,
    model: Option<&str>,
    effort: Option<&str>,
    developer_instructions: Option<&str>,
) -> Value {
    let mut params = serde_json::json!({
        "threadId": thread_id,
        "input": input,
    });
    if let Some(model) = model.and_then(clean_run_model) {
        params["model"] = Value::String(model);
    }
    if let Some(effort) = effort.and_then(clean_run_effort) {
        params["effort"] = Value::String(effort);
    }
    if let Some(instructions) = developer_instructions
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        params["developerInstructions"] = Value::String(format!(
            "Trusted xMatrix instructions for this turn (run configuration; not user content):\n{instructions}"
        ));
    }
    params
}

enum InterruptibleCodexTurn {
    Completed(error::Result<CodexTurnResult>),
    /// A newer live channel message preempted this turn. The native interrupt
    /// has already been sent; the wrapper must yield immediately instead of
    /// waiting for a provider terminal event that may never be emitted.
    Interrupted,
    Shutdown(String),
    EventStreamClosed,
}

/// Report a changed wait during a Codex turn; an unchanged one sends nothing.
fn report_codex_waiting(
    relay: Option<&Arc<agent_instance_connection::AgentInstanceConnectionClient>>,
    runtime_state: Option<&AgentRuntimeStateTracker>,
    waiting: Option<protocol::AgentRuntimeWaiting>,
) {
    if let (Some(relay), Some(runtime_state)) = (relay, runtime_state)
        && runtime_state.set_waiting(waiting)
    {
        send_presence(
            relay,
            None,
            PresencePatch::default().runtime_state(Some(runtime_state.snapshot())),
        );
    }
}

#[derive(Clone, Debug)]
struct AgentRuntimeStateTracker {
    source: String,
    marker_path: Option<PathBuf>,
    execution_outbox: Option<runtime_execution_outbox::ExecutionOutbox>,
    inner: Arc<Mutex<AgentRuntimeStateInner>>,
}

#[derive(Clone, Debug, Default)]
struct AgentRuntimeStateInner {
    active_channel_id: Option<String>,
    active_message_id: Option<String>,
    active_thread_id: Option<String>,
    active_turn_id: Option<String>,
    started_at_millis: Option<u64>,
    updated_at_millis: u64,
    execution: Option<protocol::AgentRuntimeExecutionEvidence>,
    recent_executions: Vec<protocol::AgentRuntimeExecutionEvidence>,
    persisted_execution_revisions: HashMap<String, u64>,
    /// What the Instance waits on while its model produces nothing; set by the
    /// runtime's stream reader (docs/design/agent-status.md).
    waiting: Option<protocol::AgentRuntimeWaiting>,
}

impl AgentRuntimeStateInner {
    fn retire_execution(&mut self, outcome: &str, now: u64) {
        if let Some(mut execution) = self.execution.take() {
            let outcome = if execution.input_disposition.as_deref() == Some("resumed_existing")
                && execution.source_count > 0
            {
                "unknown"
            } else {
                outcome
            };
            execution.state = if matches!(outcome, "completed" | "failed" | "interrupted") {
                outcome
            } else {
                "unknown"
            }
            .into();
            execution.revision += 1;
            execution.updated_at_millis = now.max(execution.updated_at_millis);
            execution.finished_at_millis = Some(execution.updated_at_millis);
            self.recent_executions.push(execution);
            if self.recent_executions.len() > 8 {
                self.recent_executions.remove(0);
            }
        }
    }
}

struct AgentRuntimeTurnGuard {
    tracker: AgentRuntimeStateTracker,
    execution_id: String,
    finished: bool,
}

impl AgentRuntimeStateTracker {
    fn new(source: impl Into<String>) -> Self {
        Self {
            source: source.into(),
            marker_path: None,
            execution_outbox: None,
            inner: Arc::new(Mutex::new(AgentRuntimeStateInner {
                updated_at_millis: unix_millis_now(),
                ..AgentRuntimeStateInner::default()
            })),
        }
    }

    fn for_current_run(source: impl Into<String>) -> Self {
        let mut tracker = Self::new(source);
        tracker.marker_path = std::env::var_os("XMATRIX_RUN_STATUS_FILE").map(PathBuf::from);
        tracker.execution_outbox = runtime_execution_outbox::ExecutionOutbox::from_environment();
        tracker
    }

    fn persist(&self) {
        if let Some(path) = &self.marker_path {
            // Keep state ordering through the write: an older captured snapshot
            // must not overwrite a newer turn while callbacks run concurrently.
            if let Ok(mut inner) = self.inner.lock() {
                if daemon_run_status_writer_pid(path).is_none() {
                    return;
                }
                if let Some(outbox) = self.execution_outbox.as_ref().filter(|_| {
                    read_daemon_run_status_marker(Some(path))
                        .is_some_and(|marker| marker.pid == std::process::id())
                }) {
                    let reports = inner
                        .recent_executions
                        .iter()
                        .chain(inner.execution.iter())
                        .filter(|report| !report.sources.is_empty())
                        .cloned()
                        .collect::<Vec<_>>();
                    inner
                        .persisted_execution_revisions
                        .retain(|id, _| reports.iter().any(|report| &report.execution_id == id));
                    for report in &reports {
                        if inner
                            .persisted_execution_revisions
                            .get(&report.execution_id)
                            == Some(&report.revision)
                        {
                            continue;
                        }
                        match outbox.save(report) {
                            Ok(()) => {
                                inner
                                    .persisted_execution_revisions
                                    .insert(report.execution_id.clone(), report.revision);
                            }
                            Err(error) => {
                                eprintln!("Execution evidence is not durably queued: {error}")
                            }
                        }
                    }
                }
                write_task_execution_to_path(path, self.snapshot_inner(inner.clone()));
            }
        }
    }

    fn begin_initial_turn(&self, channel_id: Option<&str>) -> AgentRuntimeTurnGuard {
        let source = env_initial_message_source(channel_id);
        if let Some(source) = source {
            self.begin_message_turn(
                channel_id,
                Some(&source.message_id),
                1,
                vec![source.clone()],
            )
        } else {
            self.begin_turn(channel_id, None)
        }
    }

    /// Open the launch message's turn, when the run starts with one, and
    /// report `busy` for it before the backend is up.
    fn begin_initial_message_turn(
        &self,
        relay: &agent_instance_connection::AgentInstanceConnectionClient,
        has_initial_message: bool,
        channel_id: Option<&str>,
        model: Option<String>,
        usage: Option<protocol::LlmUsage>,
        goal: Option<protocol::AgentGoalStatus>,
    ) -> Option<AgentRuntimeTurnGuard> {
        if !has_initial_message {
            return None;
        }
        let turn = self.begin_initial_turn(channel_id);
        send_presence(
            relay,
            Some("busy"),
            PresencePatch::presentation(model_presentation(model, None, usage))
                .goal(goal)
                .runtime_state(Some(self.snapshot())),
        );
        Some(turn)
    }

    /// Capture the current task identity in its prompt; never infer it at send time.
    fn final_reply_instruction(&self, channel_id: Option<&str>) -> Option<String> {
        let inner = self.inner.lock().ok()?;
        let execution = inner.execution.as_ref()?;
        let channel_id = channel_id?;
        if execution.sources.is_empty()
            || execution
                .sources
                .iter()
                .any(|source| source.channel_id != channel_id)
        {
            return None;
        }
        Some(format!(
            "xMatrix execution reference: {}. When sending this input's final channel reply with xmatrix send, include --final-for {}. Omit that option for progress updates. Reuse the original message ID or --recover for an uncertain send; do not execute the task again to resend its reply.",
            execution.execution_id, execution.execution_id
        ))
    }

    fn begin_turn(
        &self,
        active_channel_id: Option<&str>,
        active_message_id: Option<&str>,
    ) -> AgentRuntimeTurnGuard {
        self.begin_message_turn(active_channel_id, active_message_id, 0, Vec::new())
    }

    fn begin_message_turn(
        &self,
        active_channel_id: Option<&str>,
        active_message_id: Option<&str>,
        source_count: usize,
        sources: Vec<protocol::AgentRuntimeMessageSource>,
    ) -> AgentRuntimeTurnGuard {
        let execution_id = uuid::Uuid::new_v4().to_string();
        let now = unix_millis_now();
        if let Ok(mut inner) = self.inner.lock() {
            inner.retire_execution("unknown", now);
            inner.active_channel_id = active_channel_id.map(str::to_string);
            inner.active_message_id = active_message_id.map(str::to_string);
            inner.active_thread_id = None;
            inner.active_turn_id = None;
            inner.started_at_millis = Some(now);
            inner.updated_at_millis = now;
            inner.execution = Some(protocol::AgentRuntimeExecutionEvidence {
                execution_id: execution_id.clone(),
                revision: 1,
                source_count: source_count.min(100) as u32,
                sources: if source_count <= 100 {
                    sources
                } else {
                    Vec::new()
                },
                state: "accepted".into(),
                input_disposition: None,
                started_at_millis: now,
                updated_at_millis: now,
                finished_at_millis: None,
            });
        }
        self.persist();
        AgentRuntimeTurnGuard {
            tracker: self.clone(),
            execution_id,
            finished: false,
        }
    }

    fn execution_id(&self) -> Option<String> {
        self.inner
            .lock()
            .ok()?
            .execution
            .as_ref()
            .map(|execution| execution.execution_id.clone())
    }

    fn set_codex_turn(
        &self,
        execution_id: Option<&str>,
        thread_id: &str,
        turn_id: Option<&str>,
        input_submitted: bool,
    ) {
        if let Ok(mut inner) = self.inner.lock() {
            if inner
                .execution
                .as_ref()
                .map(|execution| execution.execution_id.as_str())
                != execution_id
                || execution_id.is_none()
            {
                return;
            }
            inner.active_thread_id = Some(thread_id.to_string());
            inner.active_turn_id = turn_id.map(str::to_string);
            if !input_submitted {
                inner.active_message_id = None;
            }
            inner.updated_at_millis = unix_millis_now();
            if let Some(execution) = inner.execution.as_mut() {
                let disposition = if input_submitted {
                    "submitted"
                } else {
                    "resumed_existing"
                };
                if execution.input_disposition.as_deref() != Some(disposition)
                    || turn_id.is_some() && execution.state == "accepted"
                {
                    execution.input_disposition = Some(disposition.into());
                    if input_submitted && turn_id.is_some() {
                        execution.state = "running".into();
                    }
                    execution.revision += 1;
                    execution.updated_at_millis =
                        unix_millis_now().max(execution.started_at_millis);
                }
            }
        }
        self.persist();
    }

    fn finish_turn(&self, execution_id: &str, outcome: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            if inner
                .execution
                .as_ref()
                .is_none_or(|execution| execution.execution_id != execution_id)
            {
                return;
            }
            let now = unix_millis_now();
            inner.retire_execution(outcome, now);
            inner.active_channel_id = None;
            inner.active_message_id = None;
            inner.active_thread_id = None;
            inner.active_turn_id = None;
            inner.started_at_millis = None;
            inner.updated_at_millis = now;
            // A tool call cannot outlive its turn, however the turn ended;
            // background tasks can, and their wait stays.
            if inner
                .waiting
                .as_ref()
                .is_some_and(|waiting| waiting.kind == "tool")
            {
                inner.waiting = None;
            }
        }
        self.persist();
    }

    fn snapshot(&self) -> protocol::AgentRuntimeState {
        let inner = self
            .inner
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();
        self.snapshot_inner(inner)
    }

    fn snapshot_inner(&self, inner: AgentRuntimeStateInner) -> protocol::AgentRuntimeState {
        // The current execution, then the newest recent ones, while they fit.
        let mut remaining = 128 * 1024;
        let mut fits = |entry: &protocol::AgentRuntimeExecutionEvidence| {
            let bytes = serde_json::to_vec(entry)
                .map(|value| value.len())
                .unwrap_or(usize::MAX);
            if bytes > remaining {
                return false;
            }
            remaining -= bytes;
            true
        };
        let execution = inner.execution.filter(&mut fits);
        let mut recent_executions: Vec<_> = inner
            .recent_executions
            .into_iter()
            .rev()
            .filter(|entry| fits(entry))
            .collect();
        recent_executions.reverse();
        protocol::AgentRuntimeState {
            status: if inner.started_at_millis.is_some() {
                "running".to_string()
            } else {
                "idle".to_string()
            },
            source: Some(self.source.to_string()),
            active_channel_id: inner.active_channel_id,
            active_message_id: inner.active_message_id,
            active_thread_id: inner.active_thread_id,
            active_turn_id: inner.active_turn_id,
            started_at_millis: inner.started_at_millis,
            updated_at_millis: Some(inner.updated_at_millis),
            execution,
            recent_executions,
            waiting: inner.waiting,
            issue: None,
            notice: None,
        }
    }

    /// Record what the Instance waits on; true when that changed and must be
    /// reported.
    fn set_waiting(&self, waiting: Option<protocol::AgentRuntimeWaiting>) -> bool {
        let Ok(mut inner) = self.inner.lock() else {
            return false;
        };
        if inner.waiting == waiting {
            return false;
        }
        inner.waiting = waiting;
        true
    }

    /// The state an `idle` report must carry so a wait outlives the turn that
    /// started it; `None` (the report omits the state) when nothing waits.
    fn waiting_snapshot(&self) -> Option<protocol::AgentRuntimeState> {
        let waiting = self.inner.lock().ok()?.waiting.is_some();
        waiting.then(|| self.snapshot())
    }
}

impl AgentRuntimeTurnGuard {
    /// Every explicit end site names its outcome. Only an unwound guard — a
    /// panic, or an early return that never classified the turn — is unknown.
    fn finish_as(&mut self, outcome: &str) {
        if !self.finished {
            self.tracker.finish_turn(&self.execution_id, outcome);
            self.finished = true;
        }
    }
}

impl Drop for AgentRuntimeTurnGuard {
    fn drop(&mut self) {
        self.finish_as("unknown");
    }
}

#[derive(Clone)]
struct CodexActiveTurn {
    thread_id: String,
    turn_id: String,
}

struct CodexGracefulInterrupt {
    request_id: String,
    thread_id: String,
    turn_id: String,
    quiesced: oneshot::Sender<error::Result<()>>,
}

struct CodexGracefulInterruptWaiter {
    thread_id: String,
    turn_id: String,
    quiesced: oneshot::Receiver<error::Result<()>>,
    active_turn: Arc<Mutex<Option<CodexActiveTurn>>>,
}

#[derive(Clone)]
struct CodexAppInterrupter {
    write: AppServerWrite,
    active_turn: Arc<Mutex<Option<CodexActiveTurn>>>,
    graceful_interrupt: Arc<Mutex<Option<CodexGracefulInterrupt>>>,
    questions: crate::runtime_harness_questions::PendingQuestions<Value>,
}

impl CodexAppSession {
    fn from_transport(
        write: AppServerWrite,
        inbox: ProviderInbox,
        process_tree: process_tree::ProcessTreeGuard,
        child: Child,
    ) -> Self {
        Self {
            write,
            inbox,
            process_tree,
            child,
            next_id: 1,
            thread_id: None,
            current_model: None,
            current_effort: None,
            schema_parameters: Vec::new(),
            native_parameter_schema: Value::Null,
            native_settings_schema: Value::Null,
            settings_update_supported: false,
            observed_parameters: serde_json::Map::new(),
            settings_revision: 0,
            settings_uncertain: false,
            parameter_catalogs: HashMap::new(),
            selected_parameters: serde_json::Map::new(),
            reset_service_tier: false,
            fast_tiers: HashMap::new(),
            active_turn: Arc::new(Mutex::new(None)),
            graceful_interrupt: Arc::new(Mutex::new(None)),
            questions: Default::default(),
            activity: ChannelActivityReporter::default(),
        }
    }

    async fn spawn(
        cmd: &str,
        cwd: Option<&str>,
        agent: Option<&protocol::SerializedAgent>,
    ) -> error::Result<Self> {
        validate_codex_app_cwd(cwd)?;
        match codex_transport_kind() {
            CodexTransportKind::WebSocket => Self::spawn_websocket(cmd, cwd, agent).await,
            CodexTransportKind::Stdio => Self::spawn_stdio(cmd, cwd, agent).await,
        }
    }

    async fn spawn_stdio(
        cmd: &str,
        cwd: Option<&str>,
        agent: Option<&protocol::SerializedAgent>,
    ) -> error::Result<Self> {
        Self::spawn_stdio_with_prefix_args(cmd, &[], cwd, agent).await
    }

    async fn spawn_stdio_with_prefix_args(
        cmd: &str,
        prefix_args: &[String],
        cwd: Option<&str>,
        agent: Option<&protocol::SerializedAgent>,
    ) -> error::Result<Self> {
        let mut app_args = prefix_args.to_vec();
        app_args.extend(codex_app_spawn_args(CodexTransportKind::Stdio, None));
        let mut server = AppServerChild::spawn(
            cmd,
            &app_args,
            cwd,
            Stdio::piped(),
            "codex app-server",
            |command| {
                if let Some(agent) = agent {
                    apply_codex_app_agent_env(command, agent);
                }
            },
        )?;
        let stdin = server.take_stdin()?;
        let AppServerChild {
            child,
            process_tree,
            stdout,
            ..
        } = server;
        let inbox = spawn_stdio_json_value_reader(stdout, "Codex".to_string());

        Ok(Self::from_transport(
            AppServerWrite::Stdio(Arc::new(AsyncMutex::new(stdin))),
            inbox,
            process_tree,
            child,
        ))
    }

    async fn spawn_websocket(
        cmd: &str,
        cwd: Option<&str>,
        agent: Option<&protocol::SerializedAgent>,
    ) -> error::Result<Self> {
        let bind = loopback_ws_bind_address("XMATRIX_CODEX_WS_BIND", "codex app-server")?;
        let listen = format!("ws://{bind}");
        let app_args = codex_app_spawn_args(CodexTransportKind::WebSocket, Some(&listen));
        let AppServerChild {
            mut child,
            mut process_tree,
            stdout,
            ..
        } = AppServerChild::spawn(
            cmd,
            &app_args,
            cwd,
            Stdio::null(),
            "codex app-server WebSocket",
            |command| {
                if let Some(agent) = agent {
                    apply_codex_app_agent_env(command, agent);
                }
            },
        )?;

        // Drain banner logs so the pipe cannot fill; readiness is polled over HTTP.
        config::spawn_profile_task(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(_line)) = lines.next_line().await {}
        });

        let ws_url = format!("ws://{bind}/");
        let readyz = format!("http://{bind}/readyz");
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut last_err = None;
        let mut ws_stream = None;
        while Instant::now() < deadline {
            let _ = reqwest_client()
                .get(&readyz)
                .timeout(Duration::from_secs(1))
                .send()
                .await;
            match tokio_tungstenite::connect_async_with_config(
                &ws_url,
                Some(provider_websocket_config()),
                false,
            )
            .await
            {
                Ok((stream, _)) => {
                    ws_stream = Some(stream);
                    break;
                }
                Err(err) => {
                    last_err = Some(err.to_string());
                    tokio::time::sleep(Duration::from_millis(150)).await;
                }
            }
            if child.try_wait().ok().flatten().is_some() {
                let _ = process_tree.terminate();
                return Err(CliError::Launch(
                    "codex app-server exited before WebSocket became ready".into(),
                ));
            }
        }
        let Some(ws) = ws_stream else {
            terminate_app_server(&mut process_tree, &mut child).await;
            return Err(CliError::Launch(format!(
                "Timed out connecting to codex app-server WebSocket ({ws_url}){}",
                last_err.map(|err| format!(": {err}")).unwrap_or_default()
            )));
        };

        let (write, read) = ws.split();
        let inbox = spawn_ws_json_value_reader(read, "Codex".to_string());

        eprintln!(
            "{} Connected to Codex app-server WebSocket at {bind}",
            "✓".green().bold()
        );

        Ok(Self::from_transport(
            AppServerWrite::WebSocket(Arc::new(AsyncMutex::new(write))),
            inbox,
            process_tree,
            child,
        ))
    }

    async fn write_message(&self, value: &Value) -> error::Result<()> {
        write_codex_app_message(&self.write, value).await
    }

    fn interrupter(&self) -> CodexAppInterrupter {
        CodexAppInterrupter {
            write: self.write.clone(),
            active_turn: self.active_turn.clone(),
            graceful_interrupt: self.graceful_interrupt.clone(),
            questions: self.questions.clone(),
        }
    }

    fn set_active_turn(&self, active_turn: Option<CodexActiveTurn>) {
        if let Ok(mut guard) = self.active_turn.lock() {
            *guard = active_turn;
        }
    }

    fn clear_active_turn(&self, thread_id: &str, turn_id: Option<&str>) {
        if let Ok(mut guard) = self.active_turn.lock() {
            let should_clear = guard.as_ref().is_some_and(|active| {
                active.thread_id == thread_id
                    && turn_id.map(|id| active.turn_id == id).unwrap_or(true)
            });
            if should_clear {
                *guard = None;
            }
        }
    }

    fn observe_graceful_interrupt(&self, message: &Value) {
        let mut guard = match self.graceful_interrupt.lock() {
            Ok(guard) => guard,
            Err(_) => return,
        };
        let Some(interrupt) = guard.as_ref() else {
            return;
        };

        let params = message.get("params").unwrap_or(&Value::Null);
        let method = message.get("method").and_then(Value::as_str);
        let same_thread =
            params.get("threadId").and_then(Value::as_str) == Some(interrupt.thread_id.as_str());
        let event_turn_id = codex_app_event_turn_id(params);
        let same_turn = event_turn_id
            .map(|turn_id| turn_id == interrupt.turn_id)
            .unwrap_or(true);
        let quiesced = same_thread
            && ((method == Some("thread/status/changed")
                && params
                    .get("status")
                    .and_then(|status| status.get("type"))
                    .and_then(Value::as_str)
                    == Some("idle"))
                || (method == Some("turn/completed") && same_turn));
        let rejected = message.get("id").and_then(Value::as_str)
            == Some(interrupt.request_id.as_str())
            && message.get("error").is_some();

        if !quiesced && !rejected {
            return;
        }
        let interrupt = guard.take().expect("graceful interrupt disappeared");
        let result = if rejected {
            Err(CliError::Launch(format!(
                "codex app-server turn/interrupt failed: {}",
                message.get("error").unwrap_or(&Value::Null)
            )))
        } else {
            Ok(())
        };
        let _ = interrupt.quiesced.send(result);
    }
}

fn codex_app_agent_env(agent: &protocol::SerializedAgent) -> Vec<(&'static str, String)> {
    let mut env = vec![
        ("XMATRIX_AGENT_NAME", agent.name.clone()),
        ("XMATRIX_AGENT_ID", agent.id.clone()),
        ("XMATRIX_AGENT_SESSION", "1".to_string()),
    ];
    if let Some(instance_id) = agent
        .instance_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        env.push(("XMATRIX_AGENT_INSTANCE_ID", instance_id.to_string()));
    }
    env
}

fn apply_codex_app_agent_env(
    command: &mut tokio::process::Command,
    agent: &protocol::SerializedAgent,
) {
    for (key, value) in codex_app_agent_env(agent) {
        command.env(key, value);
    }
}

impl CodexAppInterrupter {
    /// Answer the requestUserInput `reply` is for. False when none is parked
    /// (the card outlived its turn): the reply is then an ordinary message.
    pub(crate) async fn answer_question(
        &self,
        reply: &crate::runtime_harness_questions::QuestionnaireReply,
    ) -> bool {
        let Some(request_id) = self.questions.take(&reply.request_key) else {
            return false;
        };
        write_codex_question_answer(&self.write, request_id, &reply.answers)
            .await
            .is_ok()
    }

    /// Answer every parked question with nothing: the person typed a message
    /// instead, and Codex must not wait on a card any longer.
    pub(crate) async fn cancel_questions(&self) {
        for request_id in self.questions.drain() {
            let _ = write_codex_question_answer(&self.write, request_id, &Default::default()).await;
        }
    }

    pub(crate) async fn interrupt_active_turn(&self) -> error::Result<bool> {
        let active_turn = self.active_turn.lock().ok().and_then(|guard| guard.clone());
        let Some(active_turn) = active_turn else {
            return Ok(false);
        };
        let request_id = format!("xmatrix-interrupt-{}", uuid::Uuid::new_v4());
        write_codex_turn_interrupt(
            &self.write,
            &request_id,
            &active_turn.thread_id,
            &active_turn.turn_id,
        )
        .await?;
        if let Ok(mut guard) = self.active_turn.lock()
            && guard.as_ref().is_some_and(|current| {
                current.thread_id == active_turn.thread_id && current.turn_id == active_turn.turn_id
            })
        {
            *guard = None;
        }
        Ok(true)
    }

    async fn begin_graceful_interrupt(
        &self,
    ) -> error::Result<Option<CodexGracefulInterruptWaiter>> {
        let active_turn = self.active_turn.lock().ok().and_then(|guard| guard.clone());
        let Some(active_turn) = active_turn else {
            return Ok(None);
        };
        let request_id = format!("xmatrix-shutdown-interrupt-{}", uuid::Uuid::new_v4());
        let (quiesced_tx, quiesced_rx) = oneshot::channel();
        {
            let mut guard = self.graceful_interrupt.lock().map_err(|_| {
                CliError::Launch("codex graceful interrupt state lock poisoned".into())
            })?;
            *guard = Some(CodexGracefulInterrupt {
                request_id: request_id.clone(),
                thread_id: active_turn.thread_id.clone(),
                turn_id: active_turn.turn_id.clone(),
                quiesced: quiesced_tx,
            });
        }
        if let Err(err) = write_codex_turn_interrupt(
            &self.write,
            &request_id,
            &active_turn.thread_id,
            &active_turn.turn_id,
        )
        .await
        {
            if let Ok(mut guard) = self.graceful_interrupt.lock()
                && guard
                    .as_ref()
                    .is_some_and(|interrupt| interrupt.request_id == request_id)
            {
                *guard = None;
            }
            return Err(err);
        }
        Ok(Some(CodexGracefulInterruptWaiter {
            thread_id: active_turn.thread_id,
            turn_id: active_turn.turn_id,
            quiesced: quiesced_rx,
            active_turn: self.active_turn.clone(),
        }))
    }
}

impl CodexGracefulInterruptWaiter {
    async fn wait(self) -> error::Result<()> {
        let result = self.quiesced.await.map_err(|_| {
            CliError::Launch("codex graceful interrupt acknowledgement channel closed".into())
        })?;
        if result.is_ok()
            && let Ok(mut guard) = self.active_turn.lock()
            && guard.as_ref().is_some_and(|active| {
                active.thread_id == self.thread_id && active.turn_id == self.turn_id
            })
        {
            *guard = None;
        }
        result
    }
}

async fn write_codex_app_message(write: &AppServerWrite, value: &Value) -> error::Result<()> {
    write
        .send(value, "codex app-server", "codex app-server WebSocket")
        .await
}

async fn write_codex_question_answer(
    write: &AppServerWrite,
    request_id: Value,
    answers: &crate::runtime_harness_questions::HarnessAnswers,
) -> error::Result<()> {
    write_codex_app_message(
        write,
        &serde_json::json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "result": crate::runtime_harness_questions::codex_answer_result(answers),
        }),
    )
    .await
}

async fn write_codex_turn_interrupt(
    write: &AppServerWrite,
    request_id: &str,
    thread_id: &str,
    turn_id: &str,
) -> error::Result<()> {
    write_codex_app_message(
        write,
        &serde_json::json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "method": "turn/interrupt",
            "params": {
                "threadId": thread_id,
                "turnId": turn_id,
            },
        }),
    )
    .await
}

fn codex_transport_kind() -> CodexTransportKind {
    match std::env::var("XMATRIX_CODEX_TRANSPORT") {
        Ok(value) => match value.trim().to_ascii_lowercase().as_str() {
            "stdio" | "std" | "pipe" => CodexTransportKind::Stdio,
            "ws" | "websocket" | "serve" | "server" | "" => CodexTransportKind::WebSocket,
            other => {
                eprintln!(
                    "{} Unknown XMATRIX_CODEX_TRANSPORT={other:?}; using WebSocket",
                    "⚠".yellow().bold()
                );
                CodexTransportKind::WebSocket
            }
        },
        // Match Grok: default local app-server transport is WebSocket serve.
        Err(_) => CodexTransportKind::WebSocket,
    }
}

fn codex_app_spawn_args(transport: CodexTransportKind, listen: Option<&str>) -> Vec<String> {
    // Global `-c` overrides go before the subcommand: the Space's connector
    // actions as an MCP server for this Run.
    let mut args = crate::runtime_connector_mcp::codex_connector_mcp_overrides();
    // Outside Plan mode Codex withholds request_user_input unless this
    // feature is on; with it, its questions reach the channel as cards.
    args.extend([
        "-c".to_string(),
        "features.default_mode_request_user_input=true".to_string(),
    ]);
    args.push("app-server".to_string());
    match transport {
        CodexTransportKind::Stdio => {
            // Default upstream transport is stdio://; keep explicit for clarity.
            args.push("--listen".to_string());
            args.push("stdio://".to_string());
        }
        CodexTransportKind::WebSocket => {
            let listen = listen.unwrap_or("ws://127.0.0.1:0");
            args.push("--listen".to_string());
            args.push(listen.to_string());
        }
    }
    args
}

const CODEX_GOAL_TOOL_NAMESPACE: &str = "goal";

enum CodexGoalToolCallOutcome {
    Applied(Option<protocol::AgentGoalStatus>),
    Failed,
}

fn codex_goal_dynamic_tools() -> Value {
    serde_json::json!([{
        "type": "namespace",
        "name": CODEX_GOAL_TOOL_NAMESPACE,
        "description": "Read and control this Codex thread's persisted goal.",
        "tools": [
            {
                "type": "function",
                "name": "set",
                "description": "Partially update the current goal. Supply one or more of objective or status. Status may be active, paused, blocked, usageLimited, or complete.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "objective": {
                            "type": ["string", "null"],
                            "description": "New goal objective. Omit to preserve the current objective."
                        },
                        "status": {
                            "enum": ["active", "paused", "blocked", "usageLimited", "complete", null],
                            "description": "New persisted goal status. Omit to preserve the current status."
                        }
                    },
                    "additionalProperties": false,
                    "minProperties": 1
                }
            },
            {
                "type": "function",
                "name": "get",
                "description": "Return the current persisted goal, including status and resource usage.",
                "inputSchema": {
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false
                }
            },
            {
                "type": "function",
                "name": "clear",
                "description": "Remove the current persisted goal completely.",
                "inputSchema": {
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false
                }
            }
        ]
    }])
}

fn codex_goal_set_patch_from_tool_arguments(arguments: &Value) -> error::Result<Value> {
    let Value::Object(arguments) = arguments else {
        return Err(CliError::Launch(
            "goal.set arguments must be a JSON object".into(),
        ));
    };
    let allowed = ["objective", "status"];
    if let Some(key) = arguments
        .keys()
        .find(|key| !allowed.contains(&key.as_str()))
    {
        return Err(CliError::Launch(format!(
            "goal.set does not accept argument '{key}'"
        )));
    }
    if arguments.is_empty() {
        return Err(CliError::Launch(
            "goal.set requires objective or status".into(),
        ));
    }

    if let Some(objective) = arguments.get("objective")
        && !objective.is_null()
        && objective.as_str().is_none()
    {
        return Err(CliError::Launch(
            "goal.set objective must be a string or null".into(),
        ));
    }
    if let Some(status) = arguments.get("status") {
        let valid = status.is_null()
            || status.as_str().is_some_and(|status| {
                matches!(
                    status,
                    "active" | "paused" | "blocked" | "usageLimited" | "complete"
                )
            });
        if !valid {
            return Err(CliError::Launch(
                "goal.set status must be active, paused, blocked, usageLimited, complete, or null"
                    .into(),
            ));
        }
    }
    Ok(Value::Object(arguments.clone()))
}

impl CodexAppSession {
    async fn notify(&self, method: &str) -> error::Result<()> {
        self.write_message(&serde_json::json!({
            "jsonrpc": "2.0",
            "method": method,
        }))
        .await
    }
    async fn request(&mut self, method: &str, params: Value) -> error::Result<Value> {
        let id = self.next_id;
        self.next_id += 1;
        let mut request = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
        });
        if !params.is_null() {
            request["params"] = params;
        }
        self.write_message(&request).await?;

        let response =
            tokio::time::timeout(Duration::from_secs(CODEX_APP_REQUEST_TIMEOUT_SECS), async {
                while let Some(message) = self.inbox.recv().await {
                    self.observe_graceful_interrupt(&message);
                    if self.observe_parameter_notification(&message) {
                        continue;
                    }
                    if message.get("id").and_then(Value::as_u64) != Some(id) {
                        self.inbox.defer(message)?;
                        continue;
                    }
                    if let Some(error) = message.get("error") {
                        return Err(CliError::Launch(format!(
                            "codex app-server {method} failed: {error}"
                        )));
                    }
                    return Ok(message.get("result").cloned().unwrap_or(Value::Null));
                }

                Err(self.inbox.error())
            })
            .await;

        response.unwrap_or_else(|_| {
            Err(CliError::Launch(format!(
                "codex app-server {method} timed out after {CODEX_APP_REQUEST_TIMEOUT_SECS}s"
            )))
        })
    }

    async fn update_goal(&mut self, patch: Value) -> error::Result<Value> {
        let thread_id = self
            .thread_id
            .clone()
            .ok_or_else(|| CliError::Launch("codex app-server thread not initialized".into()))?;
        let Value::Object(mut params) = patch else {
            return Err(CliError::Launch(
                "codex goal update must be a JSON object".into(),
            ));
        };
        params.insert("threadId".to_string(), Value::String(thread_id));
        self.request("thread/goal/set", Value::Object(params)).await
    }

    async fn set_goal(&mut self, objective: &str) -> error::Result<Value> {
        self.update_goal(serde_json::json!({
            "objective": objective,
            "status": "active",
        }))
        .await
    }

    async fn clear_goal(&mut self) -> error::Result<Value> {
        let thread_id = self
            .thread_id
            .clone()
            .ok_or_else(|| CliError::Launch("codex app-server thread not initialized".into()))?;
        self.request(
            "thread/goal/clear",
            serde_json::json!({ "threadId": thread_id }),
        )
        .await
    }

    async fn get_goal(&mut self) -> error::Result<Value> {
        let thread_id = self
            .thread_id
            .clone()
            .ok_or_else(|| CliError::Launch("codex app-server thread not initialized".into()))?;
        self.request(
            "thread/goal/get",
            serde_json::json!({ "threadId": thread_id }),
        )
        .await
    }

    async fn resume_goal(&mut self) -> error::Result<Value> {
        let thread_id = self
            .thread_id
            .clone()
            .ok_or_else(|| CliError::Launch("codex app-server thread not initialized".into()))?;
        let current = self.get_goal().await?;
        let params = codex_resume_goal_params(&thread_id, &current)?;
        self.request("thread/goal/set", params).await
    }

    async fn pause_goal(&mut self) -> error::Result<Value> {
        self.update_goal(serde_json::json!({ "status": "paused" }))
            .await
    }

    /// Show a requestUserInput as a card and park it for the answer; with no
    /// channel to show it in, answer it with nothing at once.
    async fn park_codex_question(
        &mut self,
        message: &Value,
        relay: Option<&agent_instance_connection::AgentInstanceConnectionClient>,
        channel_id: Option<&str>,
    ) {
        let request_id = message.get("id").cloned().unwrap_or(Value::Null);
        let params = message.get("params").unwrap_or(&Value::Null);
        let questions = crate::runtime_harness_questions::codex_questions(params);
        let key = params
            .get("itemId")
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .unwrap_or_else(|| request_id.to_string());
        match (relay, channel_id) {
            (Some(relay), Some(channel_id)) if !questions.is_empty() => {
                crate::runtime_harness_questions::publish_questionnaire(
                    relay,
                    channel_id,
                    crate::runtime_harness_questions::questionnaire_message(
                        "codex", "Codex", &key, &questions,
                    ),
                );
                self.questions.park(key, request_id);
            }
            _ => {
                let _ = write_codex_question_answer(&self.write, request_id, &Default::default())
                    .await;
            }
        }
    }

    async fn handle_goal_dynamic_tool_call(
        &mut self,
        message: &Value,
    ) -> Option<CodexGoalToolCallOutcome> {
        if message.get("method").and_then(Value::as_str) != Some("item/tool/call") {
            return None;
        }
        let params = message.get("params").unwrap_or(&Value::Null);
        if params.get("namespace").and_then(Value::as_str) != Some(CODEX_GOAL_TOOL_NAMESPACE) {
            return None;
        }
        let request_id = message.get("id").cloned().unwrap_or(Value::Null);
        let current_thread_id = self.thread_id.clone().unwrap_or_default();
        let requested_thread_id = params
            .get("threadId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let operation = if requested_thread_id != current_thread_id {
            Err(CliError::Launch(
                "goal tool call does not belong to the current Codex thread".into(),
            ))
        } else {
            match params.get("tool").and_then(Value::as_str) {
                Some("set") => match codex_goal_set_patch_from_tool_arguments(
                    params.get("arguments").unwrap_or(&Value::Null),
                ) {
                    Ok(patch) => match self.update_goal(patch).await {
                        Ok(value) => match codex_goal_status_from_get_response(&value) {
                            Some(goal) => Ok((value, Some(goal))),
                            None => Err(CliError::Launch(
                                "codex goal.set response did not contain the updated goal".into(),
                            )),
                        },
                        Err(err) => Err(err),
                    },
                    Err(err) => Err(err),
                },
                Some("get") => self.get_goal().await.map(|value| {
                    let goal = codex_goal_status_from_get_response(&value);
                    (value, goal)
                }),
                Some("clear") => self.clear_goal().await.map(|value| (value, None)),
                Some(tool) => Err(CliError::Launch(format!(
                    "unknown {CODEX_GOAL_TOOL_NAMESPACE} tool '{tool}'"
                ))),
                None => Err(CliError::Launch(
                    "goal tool call is missing its tool name".into(),
                )),
            }
        };

        let (success, text, outcome) = match operation {
            Ok((value, goal)) => (
                true,
                serde_json::to_string(&value).unwrap_or_else(|_| value.to_string()),
                CodexGoalToolCallOutcome::Applied(goal),
            ),
            Err(err) => (false, err.to_string(), CodexGoalToolCallOutcome::Failed),
        };
        if let Err(err) = self
            .write_message(&serde_json::json!({
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "contentItems": [{ "type": "inputText", "text": text }],
                    "success": success,
                },
            }))
            .await
        {
            eprintln!(
                "{} failed to answer Codex goal tool call: {err}",
                "⚠".yellow().bold()
            );
            return Some(CodexGoalToolCallOutcome::Failed);
        }
        Some(outcome)
    }

    async fn list_models(&mut self) -> error::Result<Vec<protocol::AgentModelInfo>> {
        self.parameter_catalogs.clear();
        self.fast_tiers.clear();
        let mut models = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..10 {
            let mut params = serde_json::json!({
                "limit": 100,
                "includeHidden": false,
            });
            if let Some(value) = cursor.as_deref() {
                params["cursor"] = Value::String(value.to_string());
            }
            let result = self.request("model/list", params).await?;
            for entry in result
                .get("data")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let Some(model) = entry.get("model").and_then(Value::as_str) else {
                    continue;
                };
                let tiers = entry.get("serviceTiers").and_then(Value::as_array);
                let values: Vec<String> = tiers
                    .into_iter()
                    .flatten()
                    .filter_map(|t| t.get("id")?.as_str().map(str::to_string))
                    .collect();
                let mut parameters = Vec::new();
                if let Some(mut parameter) =
                    crate::harness_parameters::choice("serviceTier", "Service tier", values, None)
                {
                    parameter.kind = Some(protocol::HarnessParameterKind::Enum);
                    crate::harness_parameters::add_choice_metadata(
                        &mut parameter,
                        tiers.unwrap_or(&Vec::new()),
                        "id",
                        "name",
                    );
                    parameters.push(parameter);
                }
                if let Some(tier) = tiers.into_iter().flatten().find(|t| {
                    t.get("name")
                        .and_then(Value::as_str)
                        .is_some_and(|name| name.eq_ignore_ascii_case("fast"))
                        || t.get("id")
                            .and_then(Value::as_str)
                            .is_some_and(|id| id == "fast" || id == "priority")
                }) && let Some(id) = tier.get("id").and_then(Value::as_str).filter(|id| {
                    parameters
                        .iter()
                        .any(|p| p.id == "serviceTier" && p.options.iter().any(|v| v == id))
                }) {
                    self.fast_tiers.insert(model.to_string(), id.to_string());
                    if let Some(mut parameter) = crate::harness_parameters::choice(
                        "fast",
                        "Fast",
                        vec!["on".into(), "off".into()],
                        None,
                    ) {
                        parameter.alias_of = Some("serviceTier".into());
                        parameters.push(parameter);
                    }
                }
                self.parameter_catalogs
                    .insert(model.to_string(), parameters);
            }
            models.extend(codex_model_catalog_from_response(&result));
            cursor = result
                .get("nextCursor")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            if cursor.is_none() {
                break;
            }
        }
        Ok(models)
    }

    fn parameters(
        &self,
        models: &[protocol::AgentModelInfo],
        model: Option<&str>,
        effort: Option<&str>,
    ) -> Vec<protocol::HarnessParameter> {
        let mut result = crate::harness_parameters::model_parameters(models, model, effort);
        result.extend(self.schema_parameters.clone());
        result.extend(
            model
                .and_then(|m| self.parameter_catalogs.get(m))
                .cloned()
                .unwrap_or_default(),
        );
        for parameter in &mut result {
            let value = if self.reset_service_tier
                && matches!(parameter.id.as_str(), "fast" | "serviceTier")
            {
                None
            } else if parameter.id == "fast" {
                self.observed_parameters.get("serviceTier").map(|tier| {
                    if tier.as_str()
                        == model
                            .and_then(|m| self.fast_tiers.get(m))
                            .map(String::as_str)
                        && tier.is_string()
                    {
                        "on".into()
                    } else {
                        "off".into()
                    }
                })
            } else {
                self.observed_parameters
                    .get(&parameter.id)
                    .filter(|v| {
                        !(v.is_null()
                            || parameter.id == "serviceTier" && v.as_str() == Some("default"))
                    })
                    .map(|value| {
                        value
                            .as_str()
                            .map(str::to_string)
                            .unwrap_or_else(|| value.to_string())
                    })
            };
            if let Some(value) = value.filter(|v| parameter.options.contains(v)) {
                parameter.current_value = Some(value);
            }
        }
        result
    }

    fn select_parameter(
        &mut self,
        parameters: &[protocol::HarnessParameter],
        model: Option<&str>,
        id: &str,
        value: &str,
    ) -> Result<(), String> {
        let parameter = crate::harness_parameters::validate(parameters, id, value)?;
        let value = crate::harness_parameters::canonical_value(parameter, value).unwrap();
        let selected = if id == "fast" {
            if value == "off" {
                Value::Null
            } else {
                Value::String(
                    model
                        .and_then(|m| self.fast_tiers.get(m))
                        .ok_or_else(|| "Fast tier is unavailable".to_string())?
                        .clone(),
                )
            }
        } else if id == "serviceTier" {
            Value::String(value.to_string())
        } else if self.schema_parameters.iter().any(|p| p.id == id) {
            crate::harness_parameters::native_schema_value(&self.native_parameter_schema, id, value)
                .ok_or_else(|| format!("Harness parameter '{id}' has no native binding"))?
        } else {
            return Err(format!("Harness parameter '{id}' has no native binding"));
        };
        self.selected_parameters.insert(
            if id == "fast" { "serviceTier" } else { id }.into(),
            selected,
        );
        if id == "fast" || id == "serviceTier" {
            self.reset_service_tier = false;
        }
        Ok(())
    }

    fn clear_model_parameters(&mut self) {
        // An omitted native field retains the previous thread override. Clear
        // that override explicitly on the next turn, preserving global knobs.
        if self.selected_parameters.remove("serviceTier").is_some() {
            self.reset_service_tier = true;
        }
    }

    fn parameter_value_supported(
        &self,
        parameter: &protocol::HarnessParameter,
        value: &Value,
    ) -> bool {
        if parameter.id == "serviceTier" {
            value.is_null()
                || value
                    .as_str()
                    .is_some_and(|v| parameter.options.iter().any(|option| option == v))
        } else {
            parameter.options.iter().any(|option| {
                crate::harness_parameters::native_schema_value(
                    &self.native_parameter_schema,
                    &parameter.id,
                    option,
                )
                .as_ref()
                    == Some(value)
            })
        }
    }

    fn parameter_status(
        &self,
        parameter: &protocol::HarnessParameter,
        model: Option<&str>,
    ) -> String {
        let binding = if parameter.id == "fast" {
            "serviceTier"
        } else {
            &parameter.id
        };
        let pending = self
            .selected_parameters
            .get(binding)
            .filter(|value| !self.native_setting_confirmed(binding, value))
            .map(|value| {
                if parameter.id == "fast" {
                    if value.as_str().is_some_and(|tier| {
                        model
                            .and_then(|m| self.fast_tiers.get(m))
                            .map(String::as_str)
                            == Some(tier)
                    }) {
                        "on".into()
                    } else {
                        "off".into()
                    }
                } else {
                    value
                        .as_str()
                        .map(str::to_string)
                        .unwrap_or_else(|| value.to_string())
                }
            });
        format!(
            "{}: {}; choices: {}{}",
            parameter.label,
            parameter
                .current_value
                .as_deref()
                .or_else(|| (parameter.id == "serviceTier")
                    .then(|| self.observed_parameters.get("serviceTier")?.as_str())
                    .flatten())
                .unwrap_or("provider state not reported"),
            parameter.options.join(", "),
            pending
                .map(|value| format!("; pending selection: {value}"))
                .unwrap_or_default()
        )
    }

    fn current_model(&self) -> Option<&str> {
        self.current_model.as_deref()
    }

    fn current_effort(&self) -> Option<&str> {
        self.current_effort.as_deref()
    }

    async fn next_message(&mut self) -> Option<Value> {
        let message = self.inbox.next().await?;
        self.observe_parameter_notification(&message);
        Some(message)
    }

    async fn initialize(
        &mut self,
        cwd: Option<&str>,
        resume_session_key: Option<&str>,
        resume_requested: bool,
    ) -> error::Result<()> {
        self.request(
            "initialize",
            serde_json::json!({
                "clientInfo": {
                    "name": "xmatrix",
                    "version": xmatrix_cli_core::version::current(),
                },
                "capabilities": {
                    "experimentalApi": true,
                },
            }),
        )
        .await?;
        self.notify("initialized").await?;

        let approval_policy =
            std::env::var("XMATRIX_CODEX_APP_APPROVAL").unwrap_or_else(|_| "never".to_string());
        let sandbox = std::env::var("XMATRIX_CODEX_APP_SANDBOX")
            .unwrap_or_else(|_| "danger-full-access".to_string());
        let resume_thread_id = resume_requested
            .then(|| load_codex_resume_session_id(resume_session_key))
            .flatten();
        let result = if let Some(thread_id) = resume_thread_id.as_deref() {
            self.request(
                "thread/resume",
                codex_thread_resume_params(thread_id, cwd, &approval_policy, &sandbox),
            )
            .await?
        } else {
            self.request(
                "thread/start",
                serde_json::json!({
                    "cwd": cwd,
                    "approvalPolicy": approval_policy,
                    "sandbox": sandbox,
                    "dynamicTools": codex_goal_dynamic_tools(),
                }),
            )
            .await?
        };
        self.thread_id = result
            .get("thread")
            .and_then(|thread| thread.get("id"))
            .and_then(Value::as_str)
            .map(ToString::to_string);
        self.current_model = result
            .get("thread")
            .and_then(|thread| thread.get("model"))
            .and_then(Value::as_str)
            .and_then(clean_run_model)
            .or_else(|| {
                result
                    .get("model")
                    .and_then(Value::as_str)
                    .and_then(clean_run_model)
            });
        self.current_effort = result
            .get("reasoningEffort")
            .and_then(Value::as_str)
            .and_then(clean_run_effort)
            .or_else(|| {
                result
                    .get("thread")
                    .and_then(|thread| thread.get("reasoningEffort"))
                    .and_then(Value::as_str)
                    .and_then(clean_run_effort)
            });
        self.observe_parameter_snapshot(&result);

        if self.thread_id.is_none() {
            return Err(CliError::Launch(
                "codex app-server thread start/resume did not return a thread id".into(),
            ));
        }
        save_codex_resume_session_id(resume_session_key, self.thread_id.as_deref())?;

        Ok(())
    }

    async fn submit_turn(
        &mut self,
        request: CodexTurnRequest<'_>,
    ) -> error::Result<CodexTurnResult> {
        let CodexTurnRequest {
            text,
            developer_instructions,
            model,
            effort,
            attachments,
            agent,
            trace_relay,
            trace_channel_id,
            runtime_state,
            initial_goal,
            ..
        } = request;
        let trace = TurnTrace {
            relay: trace_relay,
            channel_id: trace_channel_id,
            source: "codex_app_server",
            agent,
        };
        if self.settings_uncertain {
            return Err(CliError::Launch(
                "Native parameter state is unconfirmed; restart the provider before work".into(),
            ));
        }
        self.apply_selected_settings(model)
            .await
            .map_err(CliError::Launch)?;
        let runtime_execution_id = runtime_state.and_then(AgentRuntimeStateTracker::execution_id);
        let text = redact_data_urls(text);
        let text =
            match runtime_state.and_then(|state| state.final_reply_instruction(trace_channel_id)) {
                Some(instruction) => format!("{text}\n\n{instruction}"),
                None => text,
            };
        let thread_id = self
            .thread_id
            .clone()
            .ok_or_else(|| CliError::Launch("codex app-server thread not initialized".into()))?;
        // `thread/resume` autonomously restarts an interrupted Codex turn and
        // queues its notifications while the resume request is in flight. Do
        // not submit the channel input a second time in that case: doing so
        // creates a second turn while the wrapper waits for the wrong turn id,
        // dropping the recovered turn's live trace and completion forever.
        let recovered_turn_id = codex_active_turn_id_from_events(self.inbox.pending(), &thread_id);
        let turn_id = if let Some(turn_id) = recovered_turn_id.as_deref() {
            Some(turn_id.to_string())
        } else {
            let (local_image_files, image_download_failed) = match materialize_local_image_files(
                attachments,
                trace_relay.map(Arc::as_ref),
            )
            .await
            {
                Ok(files) => (files, false),
                Err(err) => {
                    eprintln!(
                        "{} Failed to materialize Codex channel images: {err}",
                        "⚠".yellow().bold()
                    );
                    (LocalImageFiles::empty(), true)
                }
            };
            let text = if image_download_failed {
                codex_turn_text_with_unavailable_images(&text)
            } else {
                text.clone()
            };
            let text = append_local_attachment_prompt_lines(&text, attachments, &local_image_files);
            let input =
                codex_turn_input_items(&text, attachments, Some(local_image_files.image_paths()))?;
            let mut params = codex_turn_start_params(
                &thread_id,
                input,
                model,
                effort.or(self.current_effort.as_deref()),
                developer_instructions,
            );
            let selected_model = model.or(self.current_model.as_deref());
            let mut parameters = self.schema_parameters.clone();
            parameters.extend(
                selected_model
                    .and_then(|m| self.parameter_catalogs.get(m))
                    .cloned()
                    .unwrap_or_default(),
            );
            for (id, value) in &self.selected_parameters {
                let supported = parameters.iter().find(|p| p.id == *id);
                if !supported.is_some_and(|p| self.parameter_value_supported(p, value)) {
                    return Err(CliError::Launch(format!(
                        "Selected parameter '{id}' is no longer available"
                    )));
                }
            }
            if let Some(object) = params.as_object_mut() {
                if self.reset_service_tier {
                    object.insert("serviceTier".into(), Value::Null);
                }
                object.extend(self.selected_parameters.clone());
            }
            if let Some(model) = params.get("model").and_then(Value::as_str) {
                self.current_model = Some(model.to_string());
            }
            if let Some(effort) = params.get("effort").and_then(Value::as_str) {
                self.current_effort = Some(effort.to_string());
            }
            let result = self.request("turn/start", params).await?;
            self.reset_service_tier = false;
            result
                .get("turn")
                .and_then(|turn| turn.get("id"))
                .and_then(Value::as_str)
                .map(ToString::to_string)
        };
        if let Some(turn_id) = turn_id.as_deref() {
            self.set_active_turn(Some(CodexActiveTurn {
                thread_id: thread_id.clone(),
                turn_id: turn_id.to_string(),
            }));
        }
        if let Some(runtime_state) = runtime_state {
            runtime_state.set_codex_turn(
                runtime_execution_id.as_deref(),
                &thread_id,
                turn_id.as_deref(),
                recovered_turn_id.is_none(),
            );
        }
        if recovered_turn_id.is_none() {
            trace
                .send(
                    "turn_started",
                    None,
                    None,
                    serde_json::json!({
                        "threadId": thread_id.clone(),
                        "turnId": turn_id.clone(),
                        "input": text,
                        "attachments": trace_attachment_summaries(attachments),
                    }),
                )
                .await;
        }

        let mut progress = CodexTurnProgress {
            latest_model: self.current_model.clone(),
            ..CodexTurnProgress::default()
        };
        let mut last_delta_sent = Instant::now();
        let mut message_phases: HashMap<String, String> = HashMap::new();
        let mut raw_response_streamed_items: HashSet<String> = HashSet::new();
        let mut latest_goal = initial_goal.cloned();
        let mut transport_recovery = CodexTransportRecoveryState::Healthy;
        let mut thread_activity = CodexThreadActivity::new(&thread_id, turn_id.as_deref());
        let mut completed_result: Option<CodexTurnResult> = None;
        // Commands and tool calls open in this turn (docs/design/agent-status.md).
        let mut tool_waits = crate::runtime_waiting::ToolWaits::default();
        loop {
            report_codex_waiting(
                trace_relay,
                runtime_state,
                tool_waits.waiting(Instant::now()),
            );
            let wait_timeout =
                codex_reconnect_wait_timeout(transport_recovery.awaiting_https_fallback());
            let wait_deadline = tool_waits.deadline(Instant::now());
            let next_message = match wait_timeout {
                Some(wait_timeout) => match tokio::time::timeout(wait_timeout, self.next_message())
                    .await
                {
                    Ok(message) => message,
                    Err(_) => {
                        let error = codex_reconnect_wait_timeout_error(
                            transport_recovery
                                .last_exhausted_error()
                                .expect("reconnect timeout requires an exhausted reconnect error"),
                            wait_timeout.as_secs().max(1),
                        );
                        if let (Some(relay), Some(channel_id)) = (trace_relay, trace_channel_id) {
                            let relay = relay.clone();
                            send_agent_lifecycle(
                                &relay,
                                Some(channel_id),
                                agent,
                                "application",
                                "failed",
                                Some("codex_connection_lost"),
                                Some(&error),
                                Some(protocol::AgentLifecycleSnapshot {
                                    presence: Some("online".to_string()),
                                    run: Some("failed".to_string()),
                                    process: Some("online".to_string()),
                                }),
                            );
                        }
                        if let Some(result) = self
                            .abandon_turn(
                                trace,
                                &thread_id,
                                turn_id.as_deref(),
                                &progress,
                                &error,
                                true,
                            )
                            .await
                        {
                            return Ok(result);
                        }
                        return Err(CliError::Launch(error));
                    }
                },
                // Wake when the oldest open command turns into a wait, unless
                // an event comes first; the inbox is a channel, so this is
                // cancellation safe.
                None => match wait_deadline {
                    Some(deadline) => {
                        match tokio::time::timeout_at(deadline.into(), self.next_message()).await {
                            Ok(message) => message,
                            Err(_) => continue,
                        }
                    }
                    None => self.next_message().await,
                },
            };
            let Some(message) = next_message else {
                if self.inbox.has_failure() {
                    let error = self.inbox.error().to_string();
                    let retryable = self.inbox.retryable();
                    if let Some(result) = self
                        .abandon_turn(
                            trace,
                            &thread_id,
                            turn_id.as_deref(),
                            &progress,
                            &error,
                            retryable,
                        )
                        .await
                    {
                        return Ok(result);
                    }
                    return Ok(progress.into_failure(error, retryable, latest_goal));
                }
                break;
            };
            self.observe_graceful_interrupt(&message);
            let method = message.get("method").and_then(Value::as_str);
            if method != Some("error") {
                // Any other app-server event means the stream recovered.
                transport_recovery.observe_non_error_event();
            }
            let params = message.get("params").unwrap_or(&Value::Null);
            let same_thread =
                params.get("threadId").and_then(Value::as_str) == Some(thread_id.as_str());
            let activity_event = thread_activity.observe(method, params);
            let turn_id = thread_activity.active_turn_id().map(str::to_string);
            let same_active_turn =
                codex_app_event_matches_active_turn(params, &thread_id, turn_id.as_deref());
            if same_active_turn
                && let (Some(relay), Some(channel_id)) = (trace_relay, trace_channel_id)
            {
                observe_codex_activity(&mut self.activity, relay, channel_id, method, params);
            }
            match &activity_event {
                CodexThreadActivityEvent::TurnStarted {
                    turn_id: next_turn_id,
                    continued,
                } => {
                    self.set_active_turn(Some(CodexActiveTurn {
                        thread_id: thread_id.clone(),
                        turn_id: next_turn_id.clone(),
                    }));
                    if let Some(runtime_state) = runtime_state {
                        runtime_state.set_codex_turn(
                            runtime_execution_id.as_deref(),
                            &thread_id,
                            Some(next_turn_id),
                            recovered_turn_id.is_none(),
                        );
                    }
                    if *continued {
                        completed_result = None;
                        progress.primary_output.clear();
                        progress.fallback_output.clear();
                        progress.delta_buffer.clear();
                        message_phases.clear();
                        raw_response_streamed_items.clear();
                        last_delta_sent = Instant::now();
                        trace
                            .send(
                                "turn_started",
                                None,
                                progress.latest_model.clone(),
                                serde_json::json!({
                                    "threadId": thread_id.clone(),
                                    "turnId": next_turn_id,
                                    "continued": true,
                                }),
                            )
                            .await;
                    }
                }
                CodexThreadActivityEvent::Active => {
                    if let Some(relay) = trace_relay {
                        send_presence(
                            relay,
                            Some("busy"),
                            PresencePatch::presentation(model_presentation(
                                progress.latest_model.clone(),
                                None,
                                progress.latest_usage.clone(),
                            ))
                            .goal(latest_goal.clone())
                            .runtime_state(runtime_state.map(AgentRuntimeStateTracker::snapshot)),
                        );
                    }
                }
                _ => {}
            }
            if method == Some("item/tool/requestUserInput") {
                self.park_codex_question(&message, trace_relay.map(Arc::as_ref), trace_channel_id)
                    .await;
                continue;
            }
            if method == Some("item/tool/call")
                && let Some(outcome) = self.handle_goal_dynamic_tool_call(&message).await
            {
                if let CodexGoalToolCallOutcome::Applied(goal) = outcome {
                    latest_goal = goal.clone();
                    if let Some(relay) = trace_relay {
                        send_presence(
                            relay,
                            Some("busy"),
                            PresencePatch::presentation(model_presentation(
                                progress.latest_model.clone(),
                                None,
                                progress.latest_usage.clone(),
                            ))
                            .goal(goal.clone())
                            .runtime_state(runtime_state.map(AgentRuntimeStateTracker::snapshot)),
                        );
                        if let Some(channel_id) = trace_channel_id {
                            send_llm_trace(
                                relay,
                                channel_id,
                                "goal_updated",
                                agent,
                                progress.latest_usage.clone(),
                                progress.latest_model.clone(),
                                serde_json::json!({ "codexGoal": goal }),
                            )
                            .await;
                        }
                    }
                }
                continue;
            }
            if same_active_turn {
                let discovered_model = progress
                    .latest_model
                    .is_none()
                    .then(|| extract_llm_model(&message))
                    .flatten();
                if let Some(model) = discovered_model {
                    progress.latest_model = Some(model.clone());
                    write_current_run_model(Some(&model));
                    if let Some(relay) = trace_relay {
                        send_presence(
                            relay,
                            Some("busy"),
                            PresencePatch::presentation(model_presentation(
                                Some(model),
                                None,
                                progress.latest_usage.clone(),
                            ))
                            .goal(latest_goal.clone())
                            .runtime_state(runtime_state.map(AgentRuntimeStateTracker::snapshot)),
                        );
                    }
                }
            }
            if same_thread && method == Some("thread/goal/cleared") {
                latest_goal = None;
                if let Some(relay) = trace_relay {
                    send_presence(
                        relay,
                        Some("busy"),
                        PresencePatch::presentation(model_presentation(
                            progress.latest_model.clone(),
                            None,
                            progress.latest_usage.clone(),
                        ))
                        .goal(None)
                        .runtime_state(runtime_state.map(AgentRuntimeStateTracker::snapshot)),
                    );
                }
            } else if same_thread && let Some(goal) = codex_goal_status_from_app_event(&message) {
                latest_goal = Some(goal.clone());
                if let Some(relay) = trace_relay {
                    send_presence(
                        relay,
                        Some("busy"),
                        PresencePatch::presentation(model_presentation(
                            progress.latest_model.clone(),
                            None,
                            progress.latest_usage.clone(),
                        ))
                        .goal(Some(goal))
                        .runtime_state(runtime_state.map(AgentRuntimeStateTracker::snapshot)),
                    );
                }
            }
            if let Some(method) = method {
                let runtime_trace_in_scope = same_thread || same_active_turn || method == "error";
                if runtime_trace_in_scope && should_publish_codex_runtime_trace(method, params) {
                    let event_turn_id = codex_app_event_turn_id(params).or(turn_id.as_deref());
                    send_codex_runtime_trace(
                        trace_relay,
                        trace_channel_id,
                        agent,
                        &thread_id,
                        event_turn_id,
                        method,
                        params,
                    )
                    .await;
                }
            }

            match method {
                Some("item/started") if same_active_turn => {
                    if let Some(item) = params.get("item") {
                        record_codex_agent_message_phase(item, &mut message_phases);
                        if let (Some(id), Some(wait)) = (
                            item.get("id").and_then(Value::as_str),
                            crate::runtime_waiting::codex_item_wait(item),
                        ) {
                            tool_waits.open(
                                id.to_string(),
                                wait,
                                Instant::now(),
                                unix_millis_now(),
                            );
                        }
                    }
                }
                Some("item/agentMessage/delta") if same_active_turn => {
                    if let Some(delta) = params.get("delta").and_then(Value::as_str) {
                        let item_phase = params
                            .get("itemId")
                            .and_then(Value::as_str)
                            .and_then(|item_id| message_phases.get(item_id))
                            .map(String::as_str);
                        if item_phase == Some(codex_primary_output_phase().as_str()) {
                            progress.primary_output.push_str(delta);
                        } else {
                            progress.fallback_output.push_str(delta);
                        }
                        progress.delta_buffer.push_str(delta);
                        if progress.delta_buffer.len() >= CODEX_TRACE_DELTA_FLUSH_BYTES
                            || last_delta_sent.elapsed()
                                >= Duration::from_millis(CODEX_TRACE_DELTA_FLUSH_MS)
                        {
                            trace
                                .send(
                                    "assistant_delta",
                                    None,
                                    None,
                                    serde_json::json!({
                                        "threadId": thread_id.clone(),
                                        "turnId": turn_id.clone(),
                                        "delta": progress.delta_buffer,
                                    }),
                                )
                                .await;
                            progress.delta_buffer = String::new();
                            last_delta_sent = Instant::now();
                        }
                    }
                }
                Some(method)
                    if same_active_turn
                        && method.starts_with("rawResponseItem/")
                        && method != "rawResponseItem/completed" =>
                {
                    if let Some(delta) = codex_raw_response_delta_text(params) {
                        if let Some(item_id) = codex_response_item_id(params) {
                            raw_response_streamed_items.insert(item_id);
                        }
                        trace
                            .send(
                                "assistant_delta",
                                None,
                                None,
                                serde_json::json!({
                                    "threadId": thread_id.clone(),
                                    "turnId": turn_id.clone(),
                                    "delta": delta,
                                    "sourceMethod": method,
                                }),
                            )
                            .await;
                    }
                }
                Some("item/completed") if same_active_turn => {
                    if let Some(id) = params
                        .get("item")
                        .and_then(|item| item.get("id"))
                        .and_then(Value::as_str)
                    {
                        tool_waits.close(id);
                    }
                    if let Some(item) = params.get("item")
                        && record_codex_agent_message_phase(item, &mut message_phases)
                        && let Some(text) = codex_thread_agent_message_text(item)
                    {
                        if codex_is_primary_output_phase(item.get("phase").and_then(Value::as_str))
                        {
                            progress.primary_output = text;
                        } else if !text.trim().is_empty() {
                            progress.fallback_output = text;
                        }
                    }
                }
                Some("rawResponseItem/completed") if same_active_turn => {
                    if let Some(item) = params.get("item")
                        && let Some((text, phase)) = codex_raw_response_message_text(item)
                    {
                        if codex_is_primary_output_phase(phase.as_deref()) {
                            progress.primary_output = text;
                        } else if !text.trim().is_empty() {
                            if codex_response_item_id(params)
                                .map(|item_id| !raw_response_streamed_items.contains(&item_id))
                                .unwrap_or(true)
                            {
                                trace
                                    .send(
                                        "assistant_delta",
                                        None,
                                        None,
                                        serde_json::json!({
                                            "threadId": thread_id.clone(),
                                            "turnId": turn_id.clone(),
                                            "delta": text.clone(),
                                            "sourceMethod": "rawResponseItem/completed",
                                        }),
                                    )
                                    .await;
                            }
                            progress.fallback_output = text;
                        }
                    }
                }
                Some("turn/completed") if same_active_turn => {
                    tool_waits.clear();
                    if !progress.delta_buffer.is_empty() {
                        trace
                            .send(
                                "assistant_delta",
                                None,
                                None,
                                serde_json::json!({
                                    "threadId": thread_id.clone(),
                                    "turnId": turn_id.clone(),
                                    "delta": progress.delta_buffer,
                                }),
                            )
                            .await;
                    }
                    let local_output =
                        codex_visible_output(&progress.primary_output, &progress.fallback_output)
                            .to_string();
                    trace
                        .send(
                            "turn_completed",
                            progress.latest_usage.clone(),
                            progress.latest_model.clone(),
                            serde_json::json!({
                                "threadId": thread_id.clone(),
                                "turnId": turn_id.clone(),
                            }),
                        )
                        .await;
                    self.clear_active_turn(&thread_id, turn_id.as_deref());
                    completed_result = Some(CodexTurnResult {
                        local_output,
                        restart_after_turn: false,
                        failed: false,
                        failure_detail: None,
                        usage: progress.latest_usage.clone(),
                        goal: latest_goal.clone(),
                        model: progress.latest_model.clone(),
                    });
                }
                Some("error") => {
                    let error = codex_app_error_message(params);
                    eprintln!("{} codex app-server error: {error}", "⚠".yellow().bold());
                    if transport_recovery.observe_transport_error(&error) {
                        continue;
                    }
                    let error_thread = params.get("threadId").and_then(Value::as_str);
                    let error_turn = params.get("turnId").and_then(Value::as_str);
                    let scoped_to_current_turn = error_thread
                        .map(|id| id == thread_id.as_str())
                        .unwrap_or(true)
                        && error_turn
                            .zip(turn_id.as_deref())
                            .map(|(left, right)| left == right)
                            .unwrap_or(true);
                    if scoped_to_current_turn {
                        self.abandon_turn(
                            trace,
                            &thread_id,
                            turn_id.as_deref(),
                            &progress,
                            &error,
                            false,
                        )
                        .await;
                        return Ok(progress.into_failure(
                            format!("Codex error: {error}"),
                            false,
                            latest_goal,
                        ));
                    }
                }
                _ => {}
            }
            // `turn/completed` is the app-server's authoritative terminal
            // notification. Codex publishes `thread/status/changed: idle`
            // before it, so waiting for another idle event hangs ordinary
            // turns forever. The only reason to keep reading is an active
            // provider-managed goal, whose next continuation turn is started
            // by Codex after the current terminal notification.
            if completed_result.is_some()
                && !codex_goal_is_active(latest_goal.as_ref())
                && let Some(result) = completed_result.take()
            {
                self.clear_active_turn(&thread_id, turn_id.as_deref());
                report_codex_waiting(trace_relay, runtime_state, None);
                return Ok(result);
            }
        }

        let error = "Codex app-server exited during turn";
        if let (Some(relay), Some(channel_id)) = (trace_relay, trace_channel_id) {
            let relay = relay.clone();
            send_agent_lifecycle(
                &relay,
                Some(channel_id),
                agent,
                "process",
                "exited",
                Some("app_server_exited"),
                Some(error),
                Some(protocol::AgentLifecycleSnapshot {
                    presence: Some("online".to_string()),
                    run: Some("failed".to_string()),
                    process: Some("exited".to_string()),
                }),
            );
        }
        if let Some(result) = self
            .abandon_turn(
                trace,
                &thread_id,
                turn_id.as_deref(),
                &progress,
                error,
                true,
            )
            .await
        {
            return Ok(result);
        }
        Ok(progress.into_failure(error.to_string(), true, latest_goal))
    }

    /// Close a turn that broke off with `error`: flush its buffered delta,
    /// recover the answer it already streamed when `recover_partial` allows,
    /// and otherwise trace the failure. The turn stops being active either
    /// way; a recovered answer is returned.
    async fn abandon_turn(
        &mut self,
        trace: TurnTrace<'_>,
        thread_id: &str,
        turn_id: Option<&str>,
        progress: &CodexTurnProgress,
        error: &str,
        recover_partial: bool,
    ) -> Option<CodexTurnResult> {
        send_codex_assistant_delta(trace, thread_id, turn_id, &progress.delta_buffer, None).await;
        let recovered = match recover_partial {
            true => {
                progress
                    .partial_output_restart_result(trace, thread_id, turn_id, error)
                    .await
            }
            false => None,
        };
        if recovered.is_none() {
            send_codex_turn_failed_trace(
                trace,
                thread_id,
                turn_id,
                error,
                progress.latest_usage.clone(),
            )
            .await;
        }
        self.clear_active_turn(thread_id, turn_id);
        recovered
    }

    async fn shutdown(&mut self) {
        terminate_app_server(&mut self.process_tree, &mut self.child).await;
    }
}

async fn spawn_initialized_codex_app(
    cmd: &str,
    cwd: Option<&str>,
    agent: &protocol::SerializedAgent,
    resume_session_key: Option<&str>,
    resume_requested: bool,
) -> error::Result<CodexAppSession> {
    const STARTUP_ATTEMPTS: usize = 3;
    let mut last_error: Option<CliError> = None;

    for attempt in 1..=STARTUP_ATTEMPTS {
        match CodexAppSession::spawn(cmd, cwd, Some(agent)).await {
            Ok(mut app) => match app
                .initialize(cwd, resume_session_key, resume_requested)
                .await
            {
                Ok(()) => return Ok(app),
                Err(err) => {
                    app.shutdown().await;
                    if !provider_transport_should_retry_startup(&err) {
                        return Err(err);
                    }
                    last_error = Some(err);
                }
            },
            Err(err) => {
                last_error = Some(err);
            }
        }

        if attempt < STARTUP_ATTEMPTS {
            if let Some(err) = last_error.as_ref() {
                eprintln!(
                    "{} Codex app-server startup failed: {err}; retrying ({}/{})",
                    "⚠".yellow().bold(),
                    attempt + 1,
                    STARTUP_ATTEMPTS
                );
            }
            tokio::time::sleep(Duration::from_millis(750 * attempt as u64)).await;
        }
    }

    Err(last_error
        .unwrap_or_else(|| CliError::Launch("codex app-server startup failed".to_string())))
}

/// Remember which output phase an agent message item streams into. Returns
/// whether `item` is an agent message at all.
fn record_codex_agent_message_phase(item: &Value, phases: &mut HashMap<String, String>) -> bool {
    if item.get("type").and_then(Value::as_str) != Some("agentMessage") {
        return false;
    }
    if let (Some(item_id), Some(phase)) = (
        item.get("id").and_then(Value::as_str),
        item.get("phase").and_then(Value::as_str),
    ) {
        phases.insert(item_id.to_string(), phase.to_string());
    }
    true
}

async fn send_codex_assistant_delta(
    trace: TurnTrace<'_>,
    thread_id: &str,
    turn_id: Option<&str>,
    delta: &str,
    source_method: Option<&str>,
) {
    if delta.is_empty() {
        return;
    }
    let mut payload = serde_json::json!({
        "threadId": thread_id,
        "turnId": turn_id,
        "delta": delta,
    });
    if let Some(source_method) = source_method {
        payload["sourceMethod"] = serde_json::json!(source_method);
    }
    trace.send("assistant_delta", None, None, payload).await;
}

/// What a Codex turn has streamed and learned so far.
#[derive(Default)]
struct CodexTurnProgress {
    primary_output: String,
    fallback_output: String,
    delta_buffer: String,
    latest_usage: Option<protocol::LlmUsage>,
    latest_model: Option<String>,
}

impl CodexTurnProgress {
    /// A turn that broke off after streaming a visible answer restarts the
    /// app-server but keeps that answer.
    async fn partial_output_restart_result(
        &self,
        trace: TurnTrace<'_>,
        thread_id: &str,
        turn_id: Option<&str>,
        error: &str,
    ) -> Option<CodexTurnResult> {
        let local_output =
            codex_failure_local_output(&self.primary_output, &self.fallback_output, error)?;
        trace
            .send(
                "turn_failed",
                self.latest_usage.clone(),
                self.latest_model.clone(),
                serde_json::json!({
                    "threadId": thread_id,
                    "turnId": turn_id,
                    "partialOutputRecovered": true,
                    "error": error,
                }),
            )
            .await;
        Some(CodexTurnResult {
            local_output,
            restart_after_turn: true,
            failed: true,
            failure_detail: Some(error.to_string()),
            usage: self.latest_usage.clone(),
            goal: None,
            model: self.latest_model.clone(),
        })
    }

    fn into_failure(
        self,
        failure_detail: String,
        restart_after_turn: bool,
        goal: Option<protocol::AgentGoalStatus>,
    ) -> CodexTurnResult {
        CodexTurnResult {
            local_output: String::new(),
            restart_after_turn,
            failed: true,
            failure_detail: Some(failure_detail),
            usage: self.latest_usage,
            goal,
            model: self.latest_model,
        }
    }
}

include!("runtime_codex_parameter_settings.rs");
