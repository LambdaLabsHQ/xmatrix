use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::PathBuf,
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicU64, Ordering},
    },
};

use futures_util::{SinkExt, StreamExt};
use tokio::sync::{Notify, mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;

use crate::agent_instance_delivery::{
    PROMPT_CARRIED_HISTORY, RegisteredAuthor, delivery_is_acknowledged_and_dropped,
    join_after_sequence, registered_author_from, spawn_initial_message_id,
};
pub use crate::agent_instance_delivery::{PromptCarriedHistory, record_prompt_carried_history};
use crate::agent_runtime_issue::RuntimeIssueTracker;
use crate::agent_trace_read::{
    TRACE_HISTORY_MAX_WAIT_MS, TraceHistoryRead, read_trace_history, try_start_trace_wait,
    wait_for_trace_history,
};
use crate::agent_trace_store::{AgentHostTraceStore, trace_timestamp_now};
use crate::config;
use crate::connection_error::durable_object_runtime_reset;
use crate::error::{CliError, Result};
use crate::http;
use crate::protocol::*;
use crate::websocket::connection_host;

const HEARTBEAT_INTERVAL_MS: u64 = 60_000;
const HEARTBEAT_RETRY_BASE_MS: u64 = 500;
const HEARTBEAT_RETRY_MAX_MS: u64 = 4_000;
const HEARTBEAT_TIMEOUT_MS: u64 = 90_000;
const TRACE_REAP_INTERVAL_MS: u64 = HEARTBEAT_INTERVAL_MS;
const CONNECT_TIMEOUT_MS: u64 = 15_000;
const REGISTER_RESPONSE_TIMEOUT_SECS: u64 = 20;
const WS_SEND_TIMEOUT_MS: u64 = 10_000;
const REQUEST_TIMEOUT_MS: u64 = 30_000;
const WRITE_CHANNEL_CAPACITY: usize = 256;

// Reconnection constants
const RECONNECT_BASE_MS: u64 = 1_000;
const RECONNECT_MAX_MS: u64 = 30_000;
const RECONNECT_JITTER_MS: u64 = 500;
const CLIENT_NETWORK_REASON_MAX_CHARS: usize = 240;
const CLIENT_NETWORK_SAMPLE_MAX_CHANNELS: usize = 1;
const CLIENT_NETWORK_SAMPLE_FAILURE_LOG_INTERVAL_MS: u64 = 60_000;
static LAST_CLIENT_NETWORK_SAMPLE_FAILURE_LOG_MS: AtomicU64 = AtomicU64::new(0);
const CHANNEL_ATTACHMENT_PRODUCT_MEDIA_MAX_BYTES: u64 = 64 * 1024 * 1024;
const CHANNEL_ATTACHMENT_PRODUCT_MEDIA_NOT_FOUND_RETRY_MS: [u64; 2] = [100, 250];
// Live delivery is at-least-once: a retry can race the first successful frame
// on the same WebSocket. Keep only a bounded per-socket identity window so an
// unacknowledged message is still eligible for replay after reconnect.
const CHANNEL_DELIVERY_DEDUP_CAPACITY: usize = 1_024;

#[derive(Debug, Clone, Default)]
struct AgentPresenceSnapshot {
    status: Option<String>,
    activity: Option<String>,
    files: Option<Vec<String>>,
    intent: Option<String>,
    git_branch: Option<String>,
    capabilities: Option<Vec<String>>,
    runtime_state: Option<AgentRuntimeState>,
    goal: Option<Option<AgentGoalStatus>>,
    model: Option<String>,
    models: Option<Vec<AgentModelInfo>>,
    effort: Option<String>,
    commands: Option<Vec<AgentInstanceCommand>>,
    parameters: Option<Vec<crate::protocol::HarnessParameter>>,
    status_chips: Option<Vec<AgentStatusChip>>,
    usage: Option<LlmUsage>,
    runtime_issue: RuntimeIssueTracker,
    issue_dirty: bool,
    issue_projected: bool,
}

impl AgentPresenceSnapshot {
    fn merge(&mut self, update: &AgentInstanceClientMessage) {
        let AgentInstanceClientMessage::PresenceUpdate {
            status,
            activity,
            files,
            intent,
            git_branch,
            capabilities,
            runtime_state,
            goal,
            model,
            models,
            effort,
            commands,
            parameters,
            status_chips,
            usage,
            ..
        } = update
        else {
            return;
        };

        let previous_status = self.status.clone();
        let previous_issue = self.runtime_issue.public_state();
        merge_present(&mut self.status, status);
        merge_present(&mut self.activity, activity);
        merge_present(&mut self.files, files);
        merge_present(&mut self.intent, intent);
        merge_present(&mut self.git_branch, git_branch);
        merge_present(&mut self.capabilities, capabilities);
        if runtime_state.is_some() {
            self.runtime_state = runtime_state.as_deref().cloned();
        } else if status.as_deref().is_some_and(|value| value != "busy") {
            self.runtime_state = None;
        }
        self.runtime_issue.observe_presence(
            previous_status.as_deref(),
            status.as_deref(),
            self.runtime_state.as_ref(),
            now_ms(),
        );
        self.issue_dirty |= previous_issue != self.runtime_issue.public_state();
        if goal.is_some() {
            self.goal = goal.clone();
        }
        merge_present(&mut self.model, model);
        merge_present(&mut self.models, models);
        merge_present(&mut self.effort, effort);
        merge_present(&mut self.commands, commands);
        merge_present(&mut self.parameters, parameters);
        if status_chips.is_some() {
            self.status_chips = status_chips.clone();
        } else if model.is_some() || effort.is_some() {
            self.refresh_model_effort_chips();
        }
        if let Some(usage) = usage {
            merge_usage(&mut self.usage, usage);
        }
    }

    fn refresh_model_effort_chips(&mut self) {
        let explicitly_managed = self.status_chips.is_some();
        let mut chips = self
            .status_chips
            .take()
            .unwrap_or_default()
            .into_iter()
            .filter(|chip| chip.id != "model" && chip.id != "effort")
            .collect::<Vec<_>>();
        if let Some(model) = self
            .model
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            chips.push(AgentStatusChip {
                id: "model".into(),
                label: "Model".into(),
                value: Some(model.into()),
                source: None,
                percent: None,
                reset_at: None,
            });
        }
        if let Some(effort) = self
            .effort
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            chips.push(AgentStatusChip {
                id: "effort".into(),
                label: "Effort".into(),
                value: Some(effort.into()),
                source: None,
                percent: None,
                reset_at: None,
            });
        }
        self.status_chips = if explicitly_managed || !chips.is_empty() {
            Some(chips)
        } else {
            None
        };
    }

    fn message(&self) -> AgentInstanceClientMessage {
        AgentInstanceClientMessage::PresenceUpdate {
            request_id: None,
            status: self.status.clone(),
            activity: self.activity.clone(),
            files: self.files.clone(),
            intent: self.intent.clone(),
            git_branch: self.git_branch.clone(),
            capabilities: self.capabilities.clone(),
            runtime_state: self.project_runtime_state().map(Box::new),
            goal: self.goal.clone(),
            model: self.model.clone(),
            models: self.models.clone(),
            effort: self.effort.clone(),
            commands: self.commands.clone(),
            parameters: self.parameters.clone(),
            status_chips: self.status_chips.clone(),
            usage: self.usage.clone().map(Box::new),
        }
    }

    fn project_runtime_state(&self) -> Option<AgentRuntimeState> {
        let mut state = self.runtime_state.clone();
        if state.is_none()
            && (self.runtime_issue.issue.is_some()
                || self.runtime_issue.notice.is_some()
                || self.issue_projected)
        {
            state = Some(AgentRuntimeState {
                status: if self.status.as_deref() == Some("busy") {
                    "running"
                } else {
                    "idle"
                }
                .into(),
                ..Default::default()
            });
        }
        if let Some(state) = &mut state {
            state.issue = self.runtime_issue.issue.clone();
            state.notice = self.runtime_issue.notice.clone();
        }
        state
    }

    fn publish_issue(&mut self, write_tx: &Arc<Mutex<Option<mpsc::Sender<String>>>>) {
        if !self.issue_dirty {
            return;
        }
        self.issue_projected = true;
        // Only public runtime state is pushed. Trace text stays host-local;
        // unrelated presence fields and provider samples are not republished.
        let AgentInstanceClientMessage::PresenceUpdate { runtime_state, .. } = self.message()
        else {
            return;
        };
        let mut message = Self::default().message();
        if let AgentInstanceClientMessage::PresenceUpdate {
            runtime_state: target,
            ..
        } = &mut message
        {
            *target = runtime_state;
        }
        if let Ok(json) = serde_json::to_string(&message)
            && let Ok(writer) = write_tx.lock()
            && let Some(writer) = writer.as_ref()
            && writer.try_send(json).is_ok()
        {
            self.issue_dirty = false;
        }
    }
}

fn merge_present<T: Clone>(current: &mut Option<T>, incoming: &Option<T>) {
    if let Some(incoming) = incoming {
        *current = Some(incoming.clone());
    }
}

fn quota_observation_regresses(current: &LlmUsage, incoming: &LlmUsage) -> bool {
    let observed = |usage: &LlmUsage| {
        usage.quota_observed_at.as_deref().and_then(|value| {
            time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339).ok()
        })
    };
    match (observed(current), observed(incoming)) {
        (Some(current), Some(incoming)) => incoming < current,
        (Some(_), None) => true,
        _ => false,
    }
}

fn merge_usage(current: &mut Option<LlmUsage>, incoming: &LlmUsage) {
    let current = current.get_or_insert_with(LlmUsage::default);
    merge_present(&mut current.input_tokens, &incoming.input_tokens);
    merge_present(&mut current.output_tokens, &incoming.output_tokens);
    merge_present(&mut current.total_tokens, &incoming.total_tokens);
    merge_present(
        &mut current.context_used_tokens,
        &incoming.context_used_tokens,
    );
    merge_present(
        &mut current.context_window_tokens,
        &incoming.context_window_tokens,
    );
    merge_present(
        &mut current.context_usage_percent,
        &incoming.context_usage_percent,
    );
    if incoming
        .quota_usages
        .as_ref()
        .is_some_and(|entries| !entries.is_empty())
        && !quota_observation_regresses(current, incoming)
    {
        current.quota_usages = incoming.quota_usages.clone();
        current.quota_source = incoming.quota_source.clone();
        current.quota_observed_at = incoming.quota_observed_at.clone();
        current.quota_account = incoming.quota_account.clone();
    }
    merge_present(
        &mut current.cached_input_tokens,
        &incoming.cached_input_tokens,
    );
    merge_present(
        &mut current.cache_creation_input_tokens,
        &incoming.cache_creation_input_tokens,
    );
    merge_present(
        &mut current.cache_read_input_tokens,
        &incoming.cache_read_input_tokens,
    );
    merge_present(&mut current.reasoning_tokens, &incoming.reasoning_tokens);
    merge_present(&mut current.tool_call_count, &incoming.tool_call_count);
    merge_present(&mut current.cost_usd, &incoming.cost_usd);
}

fn derive_http_base_url(hub_url: &str) -> String {
    let (secure, host) = connection_host(hub_url);
    format!("{}://{host}", if secure { "https" } else { "http" })
}

pub fn derive_connection_url(hub_url: &str) -> String {
    let (secure, host) = connection_host(hub_url);
    format!(
        "{}://{host}/ws/agent-instances",
        if secure { "wss" } else { "ws" }
    )
}

/// Events emitted to the caller, including lifecycle events for reconnection.
#[derive(Debug, Clone)]
pub enum AgentInstanceConnectionEvent {
    /// A normal server message from the hub.
    Server(AgentInstanceServerMessage),
    /// The WebSocket connection was lost. The client will attempt to reconnect.
    Disconnected { reason: String },
    /// The client has successfully reconnected and re-registered.
    Reconnected {
        agent: SerializedAgent,
        agents: Vec<SerializedAgent>,
    },
    /// A command this instance queued for *itself*, delivered through the same
    /// stream as hub traffic so a runtime's delivery loop handles it between
    /// turns instead of racing its own in-flight turn. The body is a verbatim
    /// slash command (e.g. `/goal <condition>`); see the goal inbox.
    LocalCommand { body: String },
}

#[derive(Debug)]
pub struct ChannelAttachmentDownload {
    pub bytes: Vec<u8>,
    pub mime_type: String,
}

struct PendingRequestGuard<'a> {
    client: &'a AgentInstanceConnectionClient,
    request_id: String,
}

impl Drop for PendingRequestGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut pending) = self.client.pending.try_lock() {
            pending.remove(&self.request_id);
        } else if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            let pending = self.client.pending.clone();
            let request_id = self.request_id.clone();
            runtime.spawn(async move {
                // Reader critical sections never await while holding this
                // mutex. Keep cancellation cleanup bounded even during exit.
                if let Ok(mut pending) =
                    tokio::time::timeout(std::time::Duration::from_secs(1), pending.lock()).await
                {
                    pending.remove(&request_id);
                }
            });
        }
    }
}

pub struct AgentInstanceConnectionClient {
    relay_url: String,
    token: Arc<RwLock<String>>,
    agent_id: Option<String>,
    agent_name: String,
    agent_type: String,
    metadata: Option<serde_json::Value>,
    runtime_capabilities: Vec<String>,
    instance_resume_key: Option<String>,

    // Runtime state
    write_tx: Arc<Mutex<Option<mpsc::Sender<String>>>>,
    event_tx: mpsc::UnboundedSender<AgentInstanceConnectionEvent>,
    pub event_rx: Option<mpsc::UnboundedReceiver<AgentInstanceConnectionEvent>>,
    pending: std::sync::Arc<
        tokio::sync::Mutex<HashMap<String, oneshot::Sender<AgentInstanceServerMessage>>>,
    >,
    last_server_activity_ms: std::sync::Arc<std::sync::atomic::AtomicU64>,
    /// Monotonic counter to track the current session. Stale tasks from a
    /// previous connection check this and bail out when it changes.
    generation: std::sync::Arc<std::sync::atomic::AtomicU64>,
    /// Fired by reader/ping tasks when they detect the connection is dead.
    /// The reconnect supervisor awaits this signal.
    disconnect_notify: std::sync::Arc<Notify>,
    /// Generation that most recently reported a disconnect. This keeps stale
    /// Notify permits from triggering a reconnect after a newer connection is
    /// already online.
    disconnect_generation: std::sync::Arc<std::sync::atomic::AtomicU64>,
    writer_handle: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    ping_handle: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    trace_reap_handle: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    read_handle: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    reconnect_handle: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    /// Set to true once the caller calls `disconnect()` / `graceful_disconnect()`.
    intentional_close: std::sync::Arc<std::sync::atomic::AtomicBool>,
    /// Channel IDs that should request history catch-up after reconnect.
    history_channels: Arc<Mutex<HashSet<String>>>,
    /// Last channel sequence acknowledged by the runtime. Reconnects use this
    /// as a waterline so the hub can replay only messages that were not accepted
    /// into the local runtime before a disconnect.
    /// This is intentionally process-local; if the CLI restarts, the hub's
    /// durable per-instance channel cursor is the recovery source of truth.
    channel_waterlines: Arc<Mutex<HashMap<String, u64>>>,
    /// Merged live presentation last reported by this process. A reconnect
    /// creates a fresh Runtime socket session, so replay the snapshot before
    /// exposing the new writer to concurrent outbound updates.
    latest_presence: Arc<Mutex<Option<AgentPresenceSnapshot>>>,
    trace_store: Arc<Mutex<AgentHostTraceStore>>,
    /// Frame types the connected Hub listed as accepted (`hubCapabilities`).
    hub_capabilities: Arc<RwLock<Vec<String>>>,
    /// Who this connection is as a channel author, most recently confirmed by
    /// registration and shared with the reader tasks so live echoes of this
    /// instance's own channel messages are acknowledged and dropped before any
    /// runtime sees them.
    registered_author: Arc<Mutex<Option<RegisteredAuthor>>>,
    /// Acks the runtime produced while the socket was down. The hub advances its
    /// durable channel cursor from acks alone, so a dropped ack leaves the
    /// cursor parked and the next catch-up replays work this instance already
    /// finished. Replaying them on reconnect converges the cursor instead.
    pending_acks: Arc<Mutex<VecDeque<AgentInstanceClientMessage>>>,
    /// Highest ack this process handed to a writer, per channel.
    ///
    /// `pending_acks` only catches acks that never reached a writer at all.
    /// Enqueuing one succeeds long before the frame leaves the socket, so an ack
    /// written into a dying connection is reported as sent and then lost — the
    /// exact case that parks the hub cursor. Authority folds acks with
    /// `max(acked_sequence, sequence)`, so replaying the newest ack per channel
    /// on reconnect subsumes every ack lost that way, whatever the count.
    last_channel_acks: Arc<Mutex<HashMap<String, AgentInstanceClientMessage>>>,
}

impl AgentInstanceConnectionClient {
    pub fn new(
        relay_url: String,
        token: String,
        agent_name: String,
        agent_type: String,
        metadata: Option<serde_json::Value>,
    ) -> Self {
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let agent_id = std::env::var("XMATRIX_AGENT_IDENTITY_ID_OVERRIDE")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let instance_resume_key = instance_resume_key(
            &relay_url,
            agent_id.as_deref(),
            &agent_name,
            &agent_type,
            metadata.as_ref(),
        );
        Self {
            relay_url,
            token: Arc::new(RwLock::new(token)),
            agent_id,
            agent_name,
            agent_type,
            metadata,
            runtime_capabilities: Vec::new(),
            instance_resume_key,
            write_tx: Arc::new(Mutex::new(None)),
            event_tx,
            event_rx: Some(event_rx),
            pending: std::sync::Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            last_server_activity_ms: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(
                now_ms(),
            )),
            generation: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0)),
            disconnect_notify: std::sync::Arc::new(Notify::new()),
            disconnect_generation: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0)),
            writer_handle: Arc::new(Mutex::new(None)),
            ping_handle: Arc::new(Mutex::new(None)),
            trace_reap_handle: Arc::new(Mutex::new(None)),
            read_handle: Arc::new(Mutex::new(None)),
            reconnect_handle: Arc::new(Mutex::new(None)),
            intentional_close: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            history_channels: Arc::new(Mutex::new(HashSet::new())),
            channel_waterlines: Arc::new(Mutex::new(HashMap::new())),
            latest_presence: Arc::new(Mutex::new(None)),
            trace_store: Arc::new(Mutex::new(AgentHostTraceStore::default())),
            hub_capabilities: Arc::new(RwLock::new(Vec::new())),
            registered_author: Arc::new(Mutex::new(None)),
            pending_acks: Arc::new(Mutex::new(VecDeque::new())),
            last_channel_acks: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn set_runtime_capabilities(&mut self, capabilities: Vec<String>) {
        self.runtime_capabilities = capabilities
            .into_iter()
            .map(|capability| capability.trim().to_string())
            .filter(|capability| !capability.is_empty())
            .collect();
    }

    pub fn runtime_capabilities(&self) -> Vec<String> {
        self.runtime_capabilities.clone()
    }

    /// Sender for [`AgentInstanceConnectionEvent::LocalCommand`], so an
    /// instance-local source (the goal inbox) reaches the runtime's delivery
    /// loop through the same queue as hub traffic and is handled between turns.
    pub fn local_event_sender(&self) -> mpsc::UnboundedSender<AgentInstanceConnectionEvent> {
        self.event_tx.clone()
    }

    /// Connect to the relay and register. Returns (agent, online_agents) on success.
    /// Spawns background tasks for reading, heartbeat, and auto-reconnection.
    pub async fn register(&mut self) -> Result<(SerializedAgent, Vec<SerializedAgent>)> {
        abort_task_handle(&self.reconnect_handle);
        self.intentional_close
            .store(false, std::sync::atomic::Ordering::Release);
        self.disconnect_generation
            .store(0, std::sync::atomic::Ordering::Release);
        self.metadata = metadata_with_persisted_previous_instance_id(
            self.metadata.clone(),
            self.instance_resume_key.as_deref(),
        );
        let (agent, peers) = self.connect_and_register_inner().await?;
        // Adopt the server-assigned name (may differ from the requested name
        // if the server resolved a collision with a live agent).
        self.agent_id = Some(agent.id.clone());
        self.agent_name = agent.name.clone();
        if let Ok(mut author) = self.registered_author.lock() {
            *author = registered_author_from(&agent);
        }
        self.metadata = metadata_with_previous_instance_id(self.metadata.clone(), &agent);
        save_persisted_instance_id(
            self.instance_resume_key.as_deref(),
            agent.instance_id.as_deref(),
        );
        self.start_trace_reaper();
        self.spawn_reconnect_supervisor();
        Ok((agent, peers))
    }

    /// Perform a single WebSocket connect → register handshake and spawn
    /// the reader + ping tasks for this session. Returns (registered_agent, online_agents).
    ///
    /// On connection loss, the reader or ping task fires `disconnect_notify`
    /// which the reconnect supervisor awaits.
    async fn connect_and_register_inner(
        &mut self,
    ) -> Result<(SerializedAgent, Vec<SerializedAgent>)> {
        // Bump generation — any lingering tasks from a previous session will
        // see the mismatch and exit.
        let generation_id = self
            .generation
            .fetch_add(1, std::sync::atomic::Ordering::AcqRel)
            + 1;

        // Abort previous I/O tasks if any
        self.abort_io_tasks();
        if let Ok(mut slot) = self.write_tx.lock() {
            *slot = None;
        }
        self.pending.lock().await.clear();

        let ws_stream = connect_with_timeout(&self.relay_url).await?;

        let (mut write, mut read) = ws_stream.split();

        // Reset activity timestamp
        self.last_server_activity_ms
            .store(now_ms(), std::sync::atomic::Ordering::Release);

        let token = self
            .token
            .read()
            .map_err(|_| CliError::Relay("Auth token state poisoned".into()))?
            .clone();
        let json = self.connection_message_json(token)?;
        send_ws_text_with_timeout(&mut write, json).await?;

        // Wait for Registered response
        let first_msg = match tokio::time::timeout(
            std::time::Duration::from_secs(REGISTER_RESPONSE_TIMEOUT_SECS),
            read.next(),
        )
        .await
        {
            Ok(Some(Ok(msg))) => msg,
            Ok(Some(Err(err))) => return Err(CliError::Relay(format!("Read error: {err}"))),
            Ok(None) => {
                return Err(CliError::Relay(
                    "Connection closed before registration".into(),
                ));
            }
            Err(_) => {
                return Err(crate::error::AgentOperationError {
                    message: "Timed out waiting for registration response".into(),
                    failure: AgentOperationFailure {
                        code: "relay.registration_timeout".into(),
                        stage: "relay.await_confirmation".into(),
                        origin_stage: None,
                        retryable: true,
                        diagnostic_id: format!("diag_{}", uuid::Uuid::new_v4()),
                    },
                }
                .into());
            }
        };

        let text = first_msg
            .into_text()
            .map_err(|e| CliError::Relay(format!("Non-text message: {e}")))?;

        let server_msg: AgentInstanceServerMessage = serde_json::from_str(&text)
            .map_err(|e| CliError::Relay(format!("Parse error: {e}")))?;

        let registration = match server_msg {
            AgentInstanceServerMessage::AgentInstanceConnected {
                agent,
                peers,
                hub_capabilities,
            } => {
                store_hub_capabilities(&self.hub_capabilities, hub_capabilities);
                (agent, peers)
            }
            AgentInstanceServerMessage::ShutdownRequested { reason } => {
                self.intentional_close
                    .store(true, std::sync::atomic::Ordering::Release);
                clear_persisted_instance_id(self.instance_resume_key.as_deref());
                terminate_trace_store(&self.trace_store, None);
                let message = shutdown_requested_error_message(reason.as_deref());
                let _ = self.event_tx.send(AgentInstanceConnectionEvent::Server(
                    AgentInstanceServerMessage::ShutdownRequested { reason },
                ));
                return Err(CliError::Relay(message));
            }
            AgentInstanceServerMessage::Error {
                message, failure, ..
            } => {
                return Err(agent_operation_error(message, failure));
            }
            _ => {
                return Err(CliError::Relay("Unexpected first message".into()));
            }
        };

        if let Ok(mut store) = self.trace_store.lock() {
            store.bind_session(&registration.0, now_ms());
        }

        let signals = ConnectionSignals {
            generation: self.generation.clone(),
            intentional_close: self.intentional_close.clone(),
            disconnect_notify: self.disconnect_notify.clone(),
            disconnect_generation: self.disconnect_generation.clone(),
        };
        let (write_tx, write_rx) = mpsc::channel::<String>(WRITE_CHANNEL_CAPACITY);
        replace_task_handle(
            &self.writer_handle,
            spawn_writer(
                write,
                write_rx,
                generation_id,
                signals.clone(),
                self.event_tx.clone(),
            ),
        );
        install_connected_writer(&self.write_tx, &self.latest_presence, write_tx.clone())?;

        // ── Reader task ──────────────────────────────────────────────────────
        replace_task_handle(
            &self.read_handle,
            spawn_reader(
                read,
                ReaderContext {
                    generation_id,
                    event_tx: self.event_tx.clone(),
                    pending: self.pending.clone(),
                    last_server_activity_ms: self.last_server_activity_ms.clone(),
                    signals: signals.clone(),
                    channel_waterlines: self.channel_waterlines.clone(),
                    last_channel_acks: self.last_channel_acks.clone(),
                    instance_resume_key: self.instance_resume_key.clone(),
                    trace_store: self.trace_store.clone(),
                    trace_waits: Arc::default(),
                    write_tx: write_tx.clone(),
                    registered_author: self.registered_author.clone(),
                    spawn_initial_message_id: spawn_initial_message_id(),
                },
            ),
        );

        // ── Ping task ────────────────────────────────────────────────────────
        replace_task_handle(
            &self.ping_handle,
            spawn_ping(
                write_tx.clone(),
                generation_id,
                self.last_server_activity_ms.clone(),
                signals.clone(),
                self.event_tx.clone(),
            ),
        );

        Ok(registration)
    }

    fn connection_message_json(&self, token: String) -> Result<String> {
        let capabilities = if self.runtime_capabilities.is_empty() {
            None
        } else {
            Some(self.runtime_capabilities.clone())
        };
        Ok(serde_json::to_string(&AgentInstanceConnectMessage {
            message_type: "agent_instance_connect",
            request_id: None,
            token,
            identity_id: self.agent_id.clone(),
            name: self.agent_name.clone(),
            runtime: AgentInstanceRuntimeIdentity {
                kind: self.agent_type.clone(),
                client_version: Some(crate::version::current().into()),
                protocol_version: http::CLIENT_COMPATIBILITY_PROTOCOL_VERSION,
                capabilities,
            },
            run_context: self.metadata.clone(),
        })?)
    }

    /// Spawn a background supervisor that awaits `disconnect_notify` and then
    /// reconnects with exponential backoff. Loops forever until
    /// `intentional_close` is set.
    fn spawn_reconnect_supervisor(&mut self) {
        abort_task_handle(&self.reconnect_handle);

        let relay_url = self.relay_url.clone();
        let token = self.token.clone();
        let write_tx_slot = self.write_tx.clone();
        let mut agent_id = self.agent_id.clone();
        let mut agent_name = self.agent_name.clone();
        let agent_type = self.agent_type.clone();
        let mut metadata = self.metadata.clone();
        let runtime_capabilities = self.runtime_capabilities.clone();
        let event_tx = self.event_tx.clone();
        let pending = self.pending.clone();
        let last_server_activity_ms = self.last_server_activity_ms.clone();
        let generation = self.generation.clone();
        let intentional_close = self.intentional_close.clone();
        let disconnect_notify = self.disconnect_notify.clone();
        let disconnect_generation = self.disconnect_generation.clone();
        let writer_handle = self.writer_handle.clone();
        let read_handle = self.read_handle.clone();
        let ping_handle = self.ping_handle.clone();
        let history_channels = self.history_channels.clone();
        let channel_waterlines = self.channel_waterlines.clone();
        let pending_acks = self.pending_acks.clone();
        let last_channel_acks = self.last_channel_acks.clone();
        let latest_presence = self.latest_presence.clone();
        let instance_resume_key = self.instance_resume_key.clone();
        let trace_store = self.trace_store.clone();
        let registered_author = self.registered_author.clone();
        let hub_capabilities = self.hub_capabilities.clone();

        let handle = tokio::spawn(async move {
            loop {
                // ── Wait for a disconnect signal ────────────────────────────
                disconnect_notify.notified().await;

                if intentional_close.load(std::sync::atomic::Ordering::Acquire) {
                    return;
                }
                let signal_gen = disconnect_generation.load(std::sync::atomic::Ordering::Acquire);
                if signal_gen == 0
                    || signal_gen != generation.load(std::sync::atomic::Ordering::Acquire)
                {
                    continue;
                }

                if let Ok(mut slot) = write_tx_slot.lock() {
                    *slot = None;
                }
                pending.lock().await.clear();
                abort_task_handle(&writer_handle);
                abort_task_handle(&read_handle);
                abort_task_handle(&ping_handle);
                disconnect_generation.store(0, std::sync::atomic::Ordering::Release);
                let last_activity_age_ms = now_ms().saturating_sub(
                    last_server_activity_ms.load(std::sync::atomic::Ordering::Acquire),
                );
                emit_client_network_samples(
                    &relay_url,
                    &token,
                    &history_channels,
                    "reconnect",
                    "reconnecting",
                    "failed",
                    None,
                    Some(0),
                    Some(last_activity_age_ms),
                    Some("disconnect_detected".into()),
                );

                // ── Reconnection loop with exponential backoff ──────────────
                let mut delay_ms = RECONNECT_BASE_MS;
                let mut reconnect_attempt: u32 = 0;
                let reconnect_started_ms = now_ms();

                loop {
                    if intentional_close.load(std::sync::atomic::Ordering::Acquire) {
                        return;
                    }
                    reconnect_attempt = reconnect_attempt.saturating_add(1);

                    // Jitter: use low bits of timestamp
                    let jitter = now_ms() % RECONNECT_JITTER_MS;
                    tokio::time::sleep(std::time::Duration::from_millis(delay_ms + jitter)).await;

                    if intentional_close.load(std::sync::atomic::Ordering::Acquire) {
                        return;
                    }

                    // Bump generation so stale reader/ping tasks exit
                    let new_gen = generation.fetch_add(1, std::sync::atomic::Ordering::AcqRel) + 1;

                    // Reset activity timestamp for the new session
                    last_server_activity_ms.store(now_ms(), std::sync::atomic::Ordering::Release);

                    // ── Attempt WebSocket handshake ──────────────────────────
                    let ws_stream = match connect_with_timeout(&relay_url).await {
                        Ok(stream) => stream,
                        Err(CliError::UpgradeRequired(message)) => {
                            intentional_close.store(true, std::sync::atomic::Ordering::Release);
                            let _ = event_tx.send(AgentInstanceConnectionEvent::Server(
                                AgentInstanceServerMessage::ShutdownRequested {
                                    reason: Some(message),
                                },
                            ));
                            return;
                        }
                        Err(_) => {
                            emit_client_network_samples(
                                &relay_url,
                                &token,
                                &history_channels,
                                "reconnect",
                                "reconnecting",
                                "failed",
                                None,
                                Some(reconnect_attempt),
                                Some(last_activity_age_ms),
                                Some("websocket_connect_failed".into()),
                            );
                            delay_ms = (delay_ms * 2).min(RECONNECT_MAX_MS);
                            continue;
                        }
                    };

                    let (mut write, mut read) = ws_stream.split();

                    // ── Send register ────────────────────────────────────────
                    let token_value = match token.read() {
                        Ok(token) => token.clone(),
                        Err(_) => {
                            emit_client_network_samples(
                                &relay_url,
                                &token,
                                &history_channels,
                                "reconnect",
                                "reconnecting",
                                "failed",
                                None,
                                Some(reconnect_attempt),
                                Some(last_activity_age_ms),
                                Some("auth_token_state_poisoned".into()),
                            );
                            delay_ms = (delay_ms * 2).min(RECONNECT_MAX_MS);
                            continue;
                        }
                    };
                    let capabilities = if runtime_capabilities.is_empty() {
                        None
                    } else {
                        Some(runtime_capabilities.clone())
                    };
                    let json = serde_json::to_string(&AgentInstanceConnectMessage {
                        message_type: "agent_instance_connect",
                        request_id: None,
                        token: token_value,
                        identity_id: agent_id.clone(),
                        name: agent_name.clone(),
                        runtime: AgentInstanceRuntimeIdentity {
                            kind: agent_type.clone(),
                            client_version: Some(crate::version::current().into()),
                            protocol_version: http::CLIENT_COMPATIBILITY_PROTOCOL_VERSION,
                            capabilities,
                        },
                        run_context: metadata.clone(),
                    });
                    let json = match json {
                        Ok(j) => j,
                        Err(_) => {
                            emit_client_network_samples(
                                &relay_url,
                                &token,
                                &history_channels,
                                "reconnect",
                                "reconnecting",
                                "failed",
                                None,
                                Some(reconnect_attempt),
                                Some(last_activity_age_ms),
                                Some("register_serialize_failed".into()),
                            );
                            delay_ms = (delay_ms * 2).min(RECONNECT_MAX_MS);
                            continue;
                        }
                    };
                    if send_ws_text_with_timeout(&mut write, json).await.is_err() {
                        emit_client_network_samples(
                            &relay_url,
                            &token,
                            &history_channels,
                            "reconnect",
                            "reconnecting",
                            "failed",
                            None,
                            Some(reconnect_attempt),
                            Some(last_activity_age_ms),
                            Some("register_send_failed".into()),
                        );
                        delay_ms = (delay_ms * 2).min(RECONNECT_MAX_MS);
                        continue;
                    }

                    // ── Await registration response (with timeout) ──────────
                    let first_msg = match tokio::time::timeout(
                        std::time::Duration::from_secs(REGISTER_RESPONSE_TIMEOUT_SECS),
                        read.next(),
                    )
                    .await
                    {
                        Ok(Some(Ok(msg))) => msg,
                        _ => {
                            emit_client_network_samples(
                                &relay_url,
                                &token,
                                &history_channels,
                                "reconnect",
                                "reconnecting",
                                "timeout",
                                None,
                                Some(reconnect_attempt),
                                Some(last_activity_age_ms),
                                Some("registration_response_timeout".into()),
                            );
                            delay_ms = (delay_ms * 2).min(RECONNECT_MAX_MS);
                            continue;
                        }
                    };

                    let text = match first_msg.into_text() {
                        Ok(t) => t,
                        Err(_) => {
                            emit_client_network_samples(
                                &relay_url,
                                &token,
                                &history_channels,
                                "reconnect",
                                "reconnecting",
                                "failed",
                                None,
                                Some(reconnect_attempt),
                                Some(last_activity_age_ms),
                                Some("registration_non_text_message".into()),
                            );
                            delay_ms = (delay_ms * 2).min(RECONNECT_MAX_MS);
                            continue;
                        }
                    };

                    let registration =
                        match serde_json::from_str::<AgentInstanceServerMessage>(&text) {
                            Ok(AgentInstanceServerMessage::AgentInstanceConnected {
                                agent,
                                peers,
                                hub_capabilities: advertised,
                            }) => {
                                store_hub_capabilities(&hub_capabilities, advertised);
                                (agent, peers)
                            }
                            Ok(AgentInstanceServerMessage::ShutdownRequested { reason }) => {
                                intentional_close.store(true, std::sync::atomic::Ordering::Release);
                                clear_persisted_instance_id(instance_resume_key.as_deref());
                                terminate_trace_store(&trace_store, None);
                                let _ = event_tx.send(AgentInstanceConnectionEvent::Server(
                                    AgentInstanceServerMessage::ShutdownRequested { reason },
                                ));
                                return;
                            }
                            // The Hub has said this Run can never reconnect (it
                            // ended, or a migration rebound it elsewhere).
                            // Retrying would leave a process that looks alive
                            // but never receives a turn; exit so the daemon
                            // reports it and the next summon starts fresh.
                            Ok(rejection) if terminal_reconnect_rejection(&rejection).is_some() => {
                                let reason = terminal_reconnect_rejection(&rejection);
                                intentional_close.store(true, std::sync::atomic::Ordering::Release);
                                clear_persisted_instance_id(instance_resume_key.as_deref());
                                terminate_trace_store(&trace_store, None);
                                emit_client_network_samples(
                                    &relay_url,
                                    &token,
                                    &history_channels,
                                    "reconnect",
                                    "offline",
                                    "failed",
                                    None,
                                    Some(reconnect_attempt),
                                    Some(last_activity_age_ms),
                                    Some("terminal_registration_rejection".into()),
                                );
                                let _ = event_tx.send(AgentInstanceConnectionEvent::Server(
                                    AgentInstanceServerMessage::ShutdownRequested { reason },
                                ));
                                return;
                            }
                            _ => {
                                emit_client_network_samples(
                                    &relay_url,
                                    &token,
                                    &history_channels,
                                    "reconnect",
                                    "reconnecting",
                                    "failed",
                                    None,
                                    Some(reconnect_attempt),
                                    Some(last_activity_age_ms),
                                    Some("unexpected_registration_response".into()),
                                );
                                delay_ms = (delay_ms * 2).min(RECONNECT_MAX_MS);
                                continue;
                            }
                        };

                    // ── Success! Spawn new reader + ping tasks ───────────────
                    if let Ok(mut store) = trace_store.lock() {
                        store.bind_session(&registration.0, now_ms());
                    }
                    last_server_activity_ms.store(now_ms(), std::sync::atomic::Ordering::Release);
                    disconnect_generation.store(0, std::sync::atomic::Ordering::Release);
                    let signals = ConnectionSignals {
                        generation: generation.clone(),
                        intentional_close: intentional_close.clone(),
                        disconnect_notify: disconnect_notify.clone(),
                        disconnect_generation: disconnect_generation.clone(),
                    };
                    let (new_write_tx, new_write_rx) =
                        mpsc::channel::<String>(WRITE_CHANNEL_CAPACITY);
                    replace_task_handle(
                        &writer_handle,
                        spawn_writer(
                            write,
                            new_write_rx,
                            new_gen,
                            signals.clone(),
                            event_tx.clone(),
                        ),
                    );
                    if install_connected_writer(
                        &write_tx_slot,
                        &latest_presence,
                        new_write_tx.clone(),
                    )
                    .is_err()
                    {
                        abort_task_handle(&writer_handle);
                        emit_client_network_samples(
                            &relay_url,
                            &token,
                            &history_channels,
                            "reconnect",
                            "reconnecting",
                            "failed",
                            None,
                            Some(reconnect_attempt),
                            Some(last_activity_age_ms),
                            Some("presence_replay_failed".into()),
                        );
                        delay_ms = (delay_ms * 2).min(RECONNECT_MAX_MS);
                        continue;
                    }

                    // Reader task
                    replace_task_handle(
                        &read_handle,
                        spawn_reader(
                            read,
                            ReaderContext {
                                generation_id: new_gen,
                                event_tx: event_tx.clone(),
                                pending: pending.clone(),
                                last_server_activity_ms: last_server_activity_ms.clone(),
                                signals: signals.clone(),
                                channel_waterlines: channel_waterlines.clone(),
                                last_channel_acks: last_channel_acks.clone(),
                                instance_resume_key: instance_resume_key.clone(),
                                trace_store: trace_store.clone(),
                                trace_waits: Arc::default(),
                                write_tx: new_write_tx.clone(),
                                registered_author: registered_author.clone(),
                                spawn_initial_message_id: spawn_initial_message_id(),
                            },
                        ),
                    );

                    // Ping task
                    replace_task_handle(
                        &ping_handle,
                        spawn_ping(
                            new_write_tx.clone(),
                            new_gen,
                            last_server_activity_ms.clone(),
                            signals.clone(),
                            event_tx.clone(),
                        ),
                    );

                    let (agent, peers) = registration;
                    // Adopt the server-assigned identity for future Agent Instance reconnects.
                    agent_id = Some(agent.id.clone());
                    agent_name = agent.name.clone();
                    if let Ok(mut author) = registered_author.lock() {
                        *author = registered_author_from(&agent);
                    }
                    metadata = metadata_with_previous_instance_id(metadata, &agent);
                    save_persisted_instance_id(
                        instance_resume_key.as_deref(),
                        agent.instance_id.as_deref(),
                    );

                    // Acks first: the hub advances its durable cursor from them,
                    // so flushing before the replay request keeps catch-up from
                    // resending work this instance already completed offline.
                    flush_pending_acks(&pending_acks, &new_write_tx);
                    // Queued acks only cover what never reached a writer. Acks
                    // handed to the previous socket look sent and can still die
                    // with it, so replay the newest per channel; Authority keeps the
                    // greater sequence, making a redundant one a no-op.
                    replay_last_channel_acks(&last_channel_acks, &new_write_tx);

                    let channels_for_catchup: Vec<String> = match history_channels.lock() {
                        Ok(set) => set.iter().cloned().collect(),
                        Err(_) => Vec::new(),
                    };
                    for channel_id in channels_for_catchup {
                        let after_sequence = channel_waterlines
                            .lock()
                            .ok()
                            .and_then(|waterlines| waterlines.get(&channel_id).copied());
                        let msg = reconnect_channel_catchup_message(channel_id, after_sequence);
                        if let Ok(json) = serde_json::to_string(&msg) {
                            let _ = new_write_tx.try_send(json);
                        }
                    }
                    let _ = event_tx.send(AgentInstanceConnectionEvent::Reconnected {
                        agent,
                        agents: peers,
                    });
                    emit_client_network_samples(
                        &relay_url,
                        &token,
                        &history_channels,
                        "reconnect",
                        "online",
                        "success",
                        Some(now_ms().saturating_sub(reconnect_started_ms)),
                        Some(reconnect_attempt),
                        Some(last_activity_age_ms),
                        Some("reconnected".into()),
                    );

                    // Break out of back-off loop → go back to waiting for
                    // next disconnect signal.
                    break;
                }
            }
        });

        replace_task_handle(&self.reconnect_handle, handle);
    }

    pub async fn graceful_disconnect(&self) -> Result<()> {
        self.intentional_close
            .store(true, std::sync::atomic::Ordering::Release);
        // Wake the supervisor so it can exit
        self.disconnect_notify.notify_one();

        if self.write_tx_clone().is_none() {
            self.disconnect();
            return Ok(());
        }

        let mut last_error: Option<CliError> = None;

        for _ in 0..3 {
            match self
                .request(AgentInstanceClientMessage::Unregister { request_id: None })
                .await
            {
                Ok(AgentInstanceServerMessage::Unregistered { .. }) => {
                    self.disconnect();
                    return Ok(());
                }
                Ok(_) => {
                    last_error = Some(CliError::Relay("Unexpected unregister response".into()));
                }
                Err(err) => {
                    last_error = Some(err);
                }
            }
        }

        self.disconnect();
        Err(last_error.unwrap_or_else(|| CliError::Relay("Failed to unregister".into())))
    }

    pub fn disconnect(&self) {
        terminate_trace_store(&self.trace_store, None);
        self.intentional_close
            .store(true, std::sync::atomic::Ordering::Release);
        self.disconnect_notify.notify_one();
        self.abort_io_tasks();
        abort_task_handle(&self.trace_reap_handle);
        abort_task_handle(&self.reconnect_handle);
        if let Ok(mut slot) = self.write_tx.lock() {
            *slot = None;
        }
        if let Ok(mut guard) = self.pending.try_lock() {
            guard.clear();
        }
    }

    /// Abort only the I/O tasks (read + ping), not the reconnect supervisor.
    fn abort_io_tasks(&self) {
        abort_task_handle(&self.writer_handle);
        abort_task_handle(&self.ping_handle);
        abort_task_handle(&self.read_handle);
    }

    fn start_trace_reaper(&self) {
        replace_task_handle(
            &self.trace_reap_handle,
            spawn_trace_reaper(
                self.trace_store.clone(),
                self.intentional_close.clone(),
                self.latest_presence.clone(),
                self.write_tx.clone(),
                now_ms,
            ),
        );
    }

    pub fn write_tx_clone(&self) -> Option<mpsc::Sender<String>> {
        self.write_tx.lock().ok().and_then(|slot| slot.clone())
    }

    pub fn is_connected(&self) -> bool {
        self.write_tx_clone().is_some()
    }

    pub fn update_auth_token(&self, token: String) -> Result<()> {
        *self
            .token
            .write()
            .map_err(|_| CliError::Relay("Auth token state poisoned".into()))? = token;
        Ok(())
    }

    /// Expand the client-side product-media allowlist for a channel this Agent
    /// run is already expected to touch (birth / auto-join channel, or channel
    /// coordinates on Hub-issued initial-message attachments).
    ///
    /// This does not grant server authority: Hub product-media still rechecks
    /// the run birth Channel, owner ACL, and media limits before returning
    /// bytes. It only avoids a fail-closed client gate when attachment
    /// coordinates arrive before (or outside) a single `join_channel` binding
    /// — for example thread-root images whose `channelId` differs from the
    /// auto-join channel, or initial-message materialize racing a silent join.
    pub fn allow_attachment_download_channel(&self, channel_id: &str) {
        let channel_id = channel_id.trim();
        if channel_id.is_empty() {
            return;
        }
        if let Ok(mut history) = self.history_channels.lock() {
            history.insert(channel_id.to_string());
        }
    }

    /// Read one immutable attachment body using the current short-lived Agent
    /// run token. The Hub and Authority re-check the run's birth Channel and the
    /// Human owner's live ACL before returning bytes.
    pub async fn download_channel_attachment(
        &self,
        channel_id: &str,
        message_id: &str,
        attachment_id: &str,
        expected_size: u64,
    ) -> Result<ChannelAttachmentDownload> {
        if expected_size == 0 || expected_size > CHANNEL_ATTACHMENT_PRODUCT_MEDIA_MAX_BYTES {
            return Err(CliError::Relay(
                "Channel image attachment is outside the Agent media limit".into(),
            ));
        }
        let channel_is_bound = self
            .history_channels
            .lock()
            .map(|channels| channels.contains(channel_id))
            .unwrap_or(false);
        if !channel_is_bound {
            return Err(CliError::Relay(
                "Channel image attachment is outside the Agent run binding".into(),
            ));
        }
        let stem = crate::attachment_cache::cache_stem_for_identity(
            channel_id,
            message_id,
            attachment_id,
            expected_size,
        );
        if crate::attachment_cache::attachment_recently_refused(&stem) {
            return Err(CliError::Relay(
                "Channel image attachment was refused recently; not requesting it again yet".into(),
            ));
        }
        let token = self
            .token
            .read()
            .map_err(|_| CliError::Relay("Auth token state poisoned".into()))?
            .clone();
        let url = with_route(
            &derive_http_base_url(&self.relay_url),
            HubRoutes::MESSAGE_ATTACHMENT_PRODUCT_MEDIA,
        );
        let client = http::client_for(http::ClientComponent::Daemon)?;
        let mut not_found_attempt = 0usize;
        let response = loop {
            let request = client
                .post(&url)
                .bearer_auth(&token)
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .header(reqwest::header::CACHE_CONTROL, "no-store")
                .json(&serde_json::json!({
                    "channelId": channel_id,
                    "messageId": message_id,
                    "attachmentId": attachment_id,
                }));
            let response = http::with_access_header(request, &url)?.send().await?;
            if response.status() != reqwest::StatusCode::NOT_FOUND
                || not_found_attempt >= CHANNEL_ATTACHMENT_PRODUCT_MEDIA_NOT_FOUND_RETRY_MS.len()
            {
                break response;
            }
            tokio::time::sleep(std::time::Duration::from_millis(
                CHANNEL_ATTACHMENT_PRODUCT_MEDIA_NOT_FOUND_RETRY_MS[not_found_attempt],
            ))
            .await;
            not_found_attempt += 1;
        };
        if matches!(
            response.status(),
            reqwest::StatusCode::FORBIDDEN | reqwest::StatusCode::NOT_FOUND
        ) {
            let _ = crate::attachment_cache::remember_refused_attachment(&stem);
        }
        let response = http::require_success(response, &url).await?;
        if response.content_length() != Some(expected_size) {
            return Err(CliError::Relay(
                "Channel image attachment length does not match authority".into(),
            ));
        }
        let mime_type = http::response_mime_type(&response)
            .ok_or_else(|| {
                CliError::Relay("Channel image attachment response omitted its MIME type".into())
            })?
            .to_string();
        let bytes = response.bytes().await?.to_vec();
        if bytes.len() as u64 != expected_size {
            return Err(CliError::Relay(
                "Channel image attachment body does not match authority".into(),
            ));
        }
        Ok(ChannelAttachmentDownload { bytes, mime_type })
    }

    pub async fn join_channel(&self, channel_id: String, history_limit: u32) -> Result<()> {
        // Tell the hub what the first prompt already carried, so its catch-up
        // starts after it instead of at a durable cursor a stopped predecessor
        // of this Agent left behind. Seeding the waterline keeps the same floor
        // on every reconnect of this socket.
        // A positive limit asks for a context window instead, which the
        // prompt read does not replace.
        let after_sequence = (history_limit == 0)
            .then(|| join_after_sequence(&channel_id, PROMPT_CARRIED_HISTORY.get()))
            .flatten();
        advance_channel_waterline(&self.channel_waterlines, channel_id.clone(), after_sequence);
        match self
            .request(AgentInstanceClientMessage::JoinChannel {
                request_id: None,
                channel_id: channel_id.clone(),
                history_limit,
                after_sequence,
            })
            .await?
        {
            AgentInstanceServerMessage::ChannelJoined { .. } => {
                // Insert without clearing: product-media allowlist may already
                // include birth/auto-join plus Hub-issued attachment channel
                // coordinates (e.g. thread-root images). Clearing would drop
                // those bindings and fail-closed initial-message downloads.
                if let Ok(mut history) = self.history_channels.lock() {
                    history.insert(channel_id);
                }
                emit_client_network_samples(
                    &self.relay_url,
                    &self.token,
                    &self.history_channels,
                    "initial",
                    "online",
                    "success",
                    None,
                    None,
                    None,
                    Some("channel_joined".into()),
                );
                Ok(())
            }
            AgentInstanceServerMessage::Error {
                message, failure, ..
            } => Err(agent_operation_error(message, failure)),
            _ => Err(CliError::Relay("Unexpected join_channel response".into())),
        }
    }

    pub fn replay_channel_history(
        &self,
        channel_id: String,
        history_limit: u32,
        after_sequence: Option<u64>,
    ) -> Result<()> {
        if let Ok(mut history) = self.history_channels.lock() {
            history.clear();
            history.insert(channel_id.clone());
        }
        self.send(AgentInstanceClientMessage::ReplayChannelHistory {
            request_id: None,
            channel_id,
            history_limit,
            after_sequence,
        })
    }

    pub async fn get_channel_history(
        &self,
        channel_id: String,
        limit: Option<u32>,
        before: Option<String>,
        after_sequence: Option<u64>,
    ) -> Result<Vec<ChannelMessage>> {
        match self
            .request(AgentInstanceClientMessage::GetChannelHistory {
                request_id: None,
                channel_id,
                limit,
                before,
                after_sequence,
            })
            .await?
        {
            AgentInstanceServerMessage::ChannelHistory { messages, .. } => Ok(messages),
            AgentInstanceServerMessage::Error {
                message, failure, ..
            } => Err(agent_operation_error(message, failure)),
            _ => Err(CliError::Relay(
                "Unexpected get_channel_history response".into(),
            )),
        }
    }

    /// Deliver history that was read from the verified daemon Local Replica.
    /// This is deliberately a local event injection: it never sends a history
    /// request over the Agent WebSocket and therefore cannot reach Authority payload
    /// storage or a retained legacy authority.
    pub fn publish_local_history_replay(
        &self,
        channel_id: &str,
        messages: Vec<ChannelMessage>,
    ) -> Result<()> {
        let mut previous = 0_u64;
        for entry in messages {
            if entry.channel_id != channel_id {
                return Err(CliError::Relay(
                    "Local Replica history crossed the requested channel".into(),
                ));
            }
            let sequence = entry.sequence.ok_or_else(|| {
                CliError::Relay("Local Replica history entry has no sequence".into())
            })?;
            if sequence <= previous {
                return Err(CliError::Relay(
                    "Local Replica history is not strictly ordered".into(),
                ));
            }
            previous = sequence;
            let replay = AgentInstanceServerMessage::ChannelHistoryReplay {
                message: entry,
                ack_required: Some(true),
                // Verified Local Replica history answers an explicit request
                // for undelivered work, so it keeps the default work intent.
                delivery_intent: None,
            };
            self.event_tx
                .send(AgentInstanceConnectionEvent::Server(replay))
                .map_err(|_| CliError::Relay("Local Replica history receiver closed".into()))?;
        }
        Ok(())
    }

    pub async fn send_channel_message(&self, channel_id: String, body: String) -> Result<()> {
        // Wait for the hub's dispatch receipt for explicit send commands.
        match self
            .request(authority_compatible_channel_message(
                channel_id.clone(),
                body,
            ))
            .await?
        {
            AgentInstanceServerMessage::ChannelMessageDispatched {
                channel_id: dispatched_channel_id,
                ..
            } if dispatched_channel_id == channel_id => Ok(()),
            AgentInstanceServerMessage::ChannelMessageDispatched {
                channel_id: dispatched_channel_id,
                ..
            } => Err(CliError::Relay(format!(
                "Unexpected channel_message_dispatched channel {dispatched_channel_id}"
            ))),
            AgentInstanceServerMessage::Error {
                message, failure, ..
            } => Err(agent_operation_error(message, failure)),
            _ => Err(CliError::Relay(
                "Unexpected channel_message response".into(),
            )),
        }
    }

    /// Acknowledge receipt of a channel message so the hub can clear its
    /// pending-delivery timer for this (messageId, recipient) pair.
    pub fn ack_channel_message(
        &self,
        message_id: String,
        channel_id: String,
        sequence: Option<u64>,
    ) -> Result<()> {
        let ack = AgentInstanceClientMessage::ChannelMessageAck {
            message_id,
            channel_id: channel_id.clone(),
            sequence,
        };
        // The runtime has already accepted this message. A socket that is down
        // must not turn that into repeated work after the next catch-up, so the
        // ack waits for the new writer instead of being dropped.
        remember_last_channel_ack(&self.last_channel_acks, &ack);
        if self.send(ack.clone()).is_err() {
            queue_pending_ack(&self.pending_acks, ack);
        }
        advance_channel_waterline(&self.channel_waterlines, channel_id, sequence);
        Ok(())
    }

    pub fn send_message(&self, message: AgentInstanceClientMessage) -> Result<()> {
        self.send(message)
    }

    /// A correlated ping on the same writer fences the Hub's ordered dispatch:
    /// its pong follows the durable presentation write and live-session update.
    /// A presence failure uses the same ID and wins before that pong.
    pub async fn commit_presence(&self, message: AgentInstanceClientMessage) -> Result<()> {
        if !matches!(message, AgentInstanceClientMessage::PresenceUpdate { .. }) {
            return Err(CliError::Relay("Expected a presence update".into()));
        }
        match self.request(message).await? {
            AgentInstanceServerMessage::Pong { .. } => Ok(()),
            AgentInstanceServerMessage::Error {
                message, failure, ..
            } => Err(agent_operation_error(message, failure)),
            _ => Err(CliError::Relay(
                "Unexpected presence commit response".into(),
            )),
        }
    }

    /// Whether the connected Hub accepts this client frame type. A Hub closes
    /// the socket on a type it does not know, so a newer type is sent only
    /// when the Hub listed it on connect.
    pub fn hub_accepts(&self, frame_type: &str) -> bool {
        self.hub_capabilities
            .read()
            .map(|capabilities| capabilities.iter().any(|value| value == frame_type))
            .unwrap_or(false)
    }

    async fn request(
        &self,
        mut message: AgentInstanceClientMessage,
    ) -> Result<AgentInstanceServerMessage> {
        let request_id = uuid::Uuid::new_v4().to_string();

        let presence_barrier =
            matches!(&message, AgentInstanceClientMessage::PresenceUpdate { .. });
        let generation = self.generation.load(std::sync::atomic::Ordering::Acquire);

        match &mut message {
            AgentInstanceClientMessage::Ping {
                request_id: rid, ..
            } => *rid = Some(request_id.clone()),
            AgentInstanceClientMessage::Unregister {
                request_id: rid, ..
            } => *rid = Some(request_id.clone()),
            AgentInstanceClientMessage::JoinChannel {
                request_id: rid, ..
            } => *rid = Some(request_id.clone()),
            AgentInstanceClientMessage::LeaveChannel {
                request_id: rid, ..
            } => *rid = Some(request_id.clone()),
            AgentInstanceClientMessage::GetChannelHistory {
                request_id: rid, ..
            } => *rid = Some(request_id.clone()),
            AgentInstanceClientMessage::ChannelMessage {
                request_id: rid, ..
            } => *rid = Some(request_id.clone()),
            AgentInstanceClientMessage::PresenceUpdate {
                request_id: rid, ..
            } => *rid = Some(request_id.clone()),
            _ => {}
        }
        let (tx, rx) = oneshot::channel();
        {
            let mut guard = self.pending.lock().await;
            guard.insert(request_id.clone(), tx);
        }
        let _pending_request = PendingRequestGuard {
            client: self,
            request_id: request_id.clone(),
        };

        let sent = self.enqueue(message, presence_barrier.then_some(request_id.as_str()));
        if let Err(err) = sent {
            let mut guard = self.pending.lock().await;
            guard.remove(&request_id);
            return Err(err);
        }

        match tokio::time::timeout(std::time::Duration::from_millis(REQUEST_TIMEOUT_MS), rx).await {
            Ok(Ok(_))
                if presence_barrier
                    && self.generation.load(std::sync::atomic::Ordering::Acquire) != generation =>
            {
                Err(CliError::RelayTransient(
                    "Connection changed before presence commit".into(),
                ))
            }
            Ok(Ok(message)) => Ok(message),
            Ok(Err(_)) => Err(CliError::Relay("Response channel closed".into())),
            Err(_) => {
                let mut guard = self.pending.lock().await;
                guard.remove(&request_id);
                Err(CliError::Relay(format!(
                    "Response timed out after {REQUEST_TIMEOUT_MS}ms"
                )))
            }
        }
    }

    fn send(&self, message: AgentInstanceClientMessage) -> Result<()> {
        self.enqueue(message, None)
    }

    fn enqueue(&self, mut message: AgentInstanceClientMessage, fence: Option<&str>) -> Result<()> {
        // Hold the same lock through preparation and enqueue as symptom edges
        // and reconnect replay. A racing older frame cannot clear a newer issue.
        let mut latest = if matches!(message, AgentInstanceClientMessage::PresenceUpdate { .. }) {
            Some(
                self.latest_presence
                    .lock()
                    .map_err(|_| CliError::Relay("Agent presence state poisoned".into()))?,
            )
        } else {
            None
        };
        if let Some(latest) = &mut latest {
            prepare_presence_update(latest, &mut message);
        } else {
            self.prepare_outbound_message(&mut message);
        }
        // LLM traces are retained by this Agent host and fetched only when a
        // Human opens the exact instance detail. Keeping them out of the
        // shared relay writer prevents trace volume from delaying channel
        // messages and control frames.
        if matches!(
            &message,
            AgentInstanceClientMessage::EventPublish { event_type, .. } if event_type == "llm_trace"
        ) {
            return Ok(());
        }
        let json = serde_json::to_string(&message)?;
        let writer = self
            .write_tx_clone()
            .ok_or_else(|| CliError::RelayTransient("Not connected".into()))?;
        writer
            .try_send(json)
            .map_err(|_| CliError::RelayTransient("Send failed".into()))?;
        if let Some(request_id) = fence {
            let ping = serde_json::to_string(&AgentInstanceClientMessage::Ping {
                request_id: Some(request_id.into()),
            })?;
            writer
                .try_send(ping)
                .map_err(|_| CliError::RelayTransient("Presence fence send failed".into()))?;
        }
        Ok(())
    }

    fn prepare_outbound_message(&self, message: &mut AgentInstanceClientMessage) {
        match message {
            AgentInstanceClientMessage::PresenceUpdate { .. } => {
                if let Ok(mut latest) = self.latest_presence.lock() {
                    prepare_presence_update(&mut latest, message);
                }
            }
            AgentInstanceClientMessage::EventPublish {
                channel_id,
                event_type,
                payload,
                event_id,
                timestamp,
                ..
            } if event_type == "llm_trace" => {
                let id = event_id
                    .get_or_insert_with(|| uuid::Uuid::new_v4().to_string())
                    .clone();
                let at = timestamp.get_or_insert_with(trace_timestamp_now).clone();
                if let Ok(mut store) = self.trace_store.lock() {
                    store.record(channel_id, payload.clone(), id, at, now_ms());
                }
                if let Ok(mut latest) = self.latest_presence.lock() {
                    let snapshot = latest.get_or_insert_with(AgentPresenceSnapshot::default);
                    let previous = snapshot.runtime_issue.public_state();
                    snapshot
                        .runtime_issue
                        .observe_trace(channel_id, payload, now_ms());
                    snapshot.issue_dirty |= previous != snapshot.runtime_issue.public_state();
                    snapshot.publish_issue(&self.write_tx);
                }
            }
            AgentInstanceClientMessage::AgentLifecycle {
                layer,
                status,
                reason,
                channel_id,
                ..
            } if layer == "application"
                && status == "failed"
                && matches!(reason.as_deref(), Some("turn_failed" | "usage_limited")) =>
            {
                if let Ok(mut latest) = self.latest_presence.lock() {
                    let snapshot = latest.get_or_insert_with(AgentPresenceSnapshot::default);
                    let previous = snapshot.runtime_issue.public_state();
                    snapshot
                        .runtime_issue
                        .observe_failure(channel_id.as_deref(), now_ms());
                    snapshot.issue_dirty |= previous != snapshot.runtime_issue.public_state();
                    snapshot.publish_issue(&self.write_tx);
                }
            }
            _ => {}
        }
    }
}

fn prepare_presence_update(
    latest: &mut Option<AgentPresenceSnapshot>,
    message: &mut AgentInstanceClientMessage,
) {
    // A long-running turn can still hold the quota it read at startup.
    if let AgentInstanceClientMessage::PresenceUpdate {
        usage: Some(incoming),
        ..
    } = message
        && latest
            .as_ref()
            .and_then(|s| s.usage.as_ref())
            .is_some_and(|current| quota_observation_regresses(current, incoming))
    {
        incoming.quota_usages = None;
        incoming.quota_source = None;
        incoming.quota_observed_at = None;
        incoming.quota_account = None;
    }
    let snapshot = latest.get_or_insert_with(AgentPresenceSnapshot::default);
    snapshot.merge(message);
    if let AgentInstanceClientMessage::PresenceUpdate { runtime_state, .. } = message
        && (runtime_state.is_some()
            || snapshot.runtime_issue.issue.is_some()
            || snapshot.runtime_issue.notice.is_some()
            || snapshot.issue_projected)
    {
        *runtime_state = snapshot.project_runtime_state().map(Box::new);
    }
}

#[cfg(test)]
#[path = "tests/agent_instance_runtime_issue.rs"]
mod runtime_issue_tests;

/// Hub failure codes that mean this Run's credential can never register
/// again: retrying cannot succeed, so the connection shuts down instead.
const TERMINAL_RECONNECT_FAILURE_CODES: &[&str] = &[
    "agent_run_binding_mismatch",
    "agent_run_not_live",
    "agent_instance_not_live",
    "agent_connection_superseded",
    "run_not_found",
];

fn terminal_reconnect_rejection(message: &AgentInstanceServerMessage) -> Option<String> {
    let AgentInstanceServerMessage::Error {
        message,
        failure: Some(failure),
        ..
    } = message
    else {
        return None;
    };
    if failure.retryable || !TERMINAL_RECONNECT_FAILURE_CODES.contains(&failure.code.as_str()) {
        return None;
    }
    Some(format!(
        "{message} ({}); this Agent Instance cannot reconnect",
        failure.code
    ))
}

fn reconnect_channel_catchup_message(
    channel_id: String,
    after_sequence: Option<u64>,
) -> AgentInstanceClientMessage {
    // A WebSocket reconnect creates a new Hub transport session. Re-establish
    // its active-channel binding before asking for catch-up; a replay-only
    // frame cannot inherit the prior session's in-memory join state.
    AgentInstanceClientMessage::JoinChannel {
        request_id: None,
        channel_id,
        history_limit: 0,
        after_sequence,
    }
}

impl Drop for AgentInstanceConnectionClient {
    fn drop(&mut self) {
        self.disconnect();
    }
}

fn shutdown_requested_error_message(reason: Option<&str>) -> String {
    reason
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!("Shutdown requested by server: {value}"))
        .unwrap_or_else(|| "Shutdown requested by server".to_string())
}

/// A reconnect to a different Hub replaces what the previous one accepted.
fn store_hub_capabilities(store: &Arc<RwLock<Vec<String>>>, advertised: Option<Vec<String>>) {
    if let Ok(mut capabilities) = store.write() {
        *capabilities = advertised.unwrap_or_default();
    }
}

fn terminate_trace_store(store: &Arc<Mutex<AgentHostTraceStore>>, instance_id: Option<&str>) {
    if let Ok(mut store) = store.lock() {
        store.terminate(instance_id);
    }
}

fn install_connected_writer(
    slot: &Arc<Mutex<Option<mpsc::Sender<String>>>>,
    latest_presence: &Arc<Mutex<Option<AgentPresenceSnapshot>>>,
    writer: mpsc::Sender<String>,
) -> Result<()> {
    // Keep the presentation lock until the writer becomes visible. Outbound
    // presence updates acquire this lock before reading `slot`, so an update
    // races either before this replay or after it, never into the gap.
    let latest = latest_presence
        .lock()
        .map_err(|_| CliError::Relay("Agent presence replay state poisoned".into()))?;
    if let Some(snapshot) = latest.as_ref() {
        let json = serde_json::to_string(&snapshot.message())?;
        writer
            .try_send(json)
            .map_err(|_| CliError::RelayTransient("Agent presence replay failed".into()))?;
    }
    *slot
        .lock()
        .map_err(|_| CliError::Relay("Write channel state poisoned".into()))? = Some(writer);
    Ok(())
}

fn spawn_trace_reaper<F>(
    trace_store: Arc<Mutex<AgentHostTraceStore>>,
    intentional_close: Arc<std::sync::atomic::AtomicBool>,
    latest_presence: Arc<Mutex<Option<AgentPresenceSnapshot>>>,
    write_tx: Arc<Mutex<Option<mpsc::Sender<String>>>>,
    now: F,
) -> tokio::task::JoinHandle<()>
where
    F: Fn() -> u64 + Send + Sync + 'static,
{
    tokio::spawn(async move {
        let mut interval =
            tokio::time::interval(std::time::Duration::from_millis(TRACE_REAP_INTERVAL_MS));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            if intentional_close.load(std::sync::atomic::Ordering::Acquire) {
                return;
            }
            if let Ok(mut store) = trace_store.lock() {
                store.reap_expired(now());
            }
            if let Ok(mut latest) = latest_presence.lock()
                && let Some(snapshot) = latest.as_mut()
            {
                let previous = snapshot.runtime_issue.public_state();
                snapshot.runtime_issue.tick(now());
                snapshot.issue_dirty |= previous != snapshot.runtime_issue.public_state();
                snapshot.publish_issue(&write_tx);
            }
        }
    })
}

// ── Free functions for spawning tasks ────────────────────────────────────────
// These are used by both initial registration and reconnection to avoid
// duplicating the reader/ping task logic.

type WsRead = futures_util::stream::SplitStream<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
>;
type WsWrite = futures_util::stream::SplitSink<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    Message,
>;
type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect_with_timeout(relay_url: &str) -> Result<WsStream> {
    let request = http::websocket_request(relay_url, http::ClientComponent::Daemon).await?;
    match tokio::time::timeout(
        std::time::Duration::from_millis(CONNECT_TIMEOUT_MS),
        crate::websocket::connect(request),
    )
    .await
    {
        Ok(Ok(stream)) => Ok(stream),
        Ok(Err(err)) => Err(err),
        Err(_) => Err(CliError::Relay(format!(
            "WebSocket handshake timed out after {CONNECT_TIMEOUT_MS}ms"
        ))),
    }
}

async fn send_ws_text_with_timeout(write: &mut WsWrite, text: String) -> Result<()> {
    match tokio::time::timeout(
        std::time::Duration::from_millis(WS_SEND_TIMEOUT_MS),
        write.send(Message::Text(text.into())),
    )
    .await
    {
        Ok(Ok(())) => Ok(()),
        Ok(Err(err)) => Err(CliError::Relay(format!("WebSocket write failed: {err}"))),
        Err(_) => Err(CliError::Relay(format!(
            "WebSocket write timed out after {WS_SEND_TIMEOUT_MS}ms"
        ))),
    }
}

fn replace_task_handle(
    slot: &Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    handle: tokio::task::JoinHandle<()>,
) {
    if let Ok(mut guard) = slot.lock() {
        if let Some(previous) = guard.take() {
            previous.abort();
        }
        *guard = Some(handle);
    } else {
        handle.abort();
    }
}

fn abort_task_handle(slot: &Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>) {
    if let Ok(mut guard) = slot.lock()
        && let Some(handle) = guard.take()
    {
        handle.abort();
    }
}

fn signal_disconnect(
    generation_id: u64,
    generation: &std::sync::Arc<std::sync::atomic::AtomicU64>,
    intentional_close: &std::sync::Arc<std::sync::atomic::AtomicBool>,
    disconnect_notify: &std::sync::Arc<Notify>,
    disconnect_generation: &std::sync::Arc<std::sync::atomic::AtomicU64>,
    event_tx: &mpsc::UnboundedSender<AgentInstanceConnectionEvent>,
    reason: String,
) {
    if generation.load(std::sync::atomic::Ordering::Acquire) != generation_id
        || intentional_close.load(std::sync::atomic::Ordering::Acquire)
    {
        return;
    }

    let previous = disconnect_generation.swap(generation_id, std::sync::atomic::Ordering::AcqRel);
    if previous == generation_id {
        return;
    }
    let _ = event_tx.send(AgentInstanceConnectionEvent::Disconnected { reason });
    disconnect_notify.notify_one();
}

#[derive(Clone)]
struct ConnectionSignals {
    generation: std::sync::Arc<std::sync::atomic::AtomicU64>,
    intentional_close: std::sync::Arc<std::sync::atomic::AtomicBool>,
    disconnect_notify: std::sync::Arc<Notify>,
    disconnect_generation: std::sync::Arc<std::sync::atomic::AtomicU64>,
}

impl ConnectionSignals {
    fn disconnect(
        &self,
        generation_id: u64,
        events: &mpsc::UnboundedSender<AgentInstanceConnectionEvent>,
        reason: String,
    ) {
        signal_disconnect(
            generation_id,
            &self.generation,
            &self.intentional_close,
            &self.disconnect_notify,
            &self.disconnect_generation,
            events,
            reason,
        );
    }
}

fn spawn_writer(
    mut write: WsWrite,
    mut write_rx: mpsc::Receiver<String>,
    generation_id: u64,
    signals: ConnectionSignals,
    event_tx: mpsc::UnboundedSender<AgentInstanceConnectionEvent>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        while let Some(msg) = write_rx.recv().await {
            if signals
                .generation
                .load(std::sync::atomic::Ordering::Acquire)
                != generation_id
            {
                return;
            }
            let result = tokio::time::timeout(
                std::time::Duration::from_millis(WS_SEND_TIMEOUT_MS),
                write.send(Message::Text(msg.into())),
            )
            .await;
            match result {
                Ok(Ok(())) => {}
                Ok(Err(err)) => {
                    signals.disconnect(
                        generation_id,
                        &event_tx,
                        format!("WebSocket write failed: {err}"),
                    );
                    return;
                }
                Err(_) => {
                    signals.disconnect(
                        generation_id,
                        &event_tx,
                        format!("WebSocket write timed out after {WS_SEND_TIMEOUT_MS}ms"),
                    );
                    return;
                }
            }
        }
    })
}

async fn send_trace_history_response(
    write_tx: &mpsc::Sender<String>,
    response: &AgentInstanceClientMessage,
) -> bool {
    let Ok(json) = serde_json::to_string(response) else {
        return false;
    };
    write_tx.send(json).await.is_ok()
}

struct ReaderContext {
    generation_id: u64,
    event_tx: mpsc::UnboundedSender<AgentInstanceConnectionEvent>,
    pending: std::sync::Arc<
        tokio::sync::Mutex<HashMap<String, oneshot::Sender<AgentInstanceServerMessage>>>,
    >,
    last_server_activity_ms: std::sync::Arc<std::sync::atomic::AtomicU64>,
    signals: ConnectionSignals,
    channel_waterlines: Arc<Mutex<HashMap<String, u64>>>,
    last_channel_acks: Arc<Mutex<HashMap<String, AgentInstanceClientMessage>>>,
    instance_resume_key: Option<String>,
    trace_store: Arc<Mutex<AgentHostTraceStore>>,
    /// Trace reads currently waiting for a newer event on this reader.
    trace_waits: Arc<std::sync::atomic::AtomicUsize>,
    write_tx: mpsc::Sender<String>,
    registered_author: Arc<Mutex<Option<RegisteredAuthor>>>,
    /// Set for daemon-spawned runs; see `spawn_initial_message_id`.
    spawn_initial_message_id: Option<String>,
}

impl ReaderContext {
    fn shutdown(&self, message: AgentInstanceServerMessage) {
        self.signals
            .intentional_close
            .store(true, std::sync::atomic::Ordering::Release);
        clear_persisted_instance_id(self.instance_resume_key.as_deref());
        terminate_trace_store(&self.trace_store, None);
        let _ = self
            .event_tx
            .send(AgentInstanceConnectionEvent::Server(message));
    }
}

#[derive(Default)]
struct ChannelDeliveryDeduper {
    keys: HashSet<(String, String)>,
    order: VecDeque<(String, String)>,
}

impl ChannelDeliveryDeduper {
    /// Returns false when this WebSocket already handed the exact committed
    /// message to its runtime. The state intentionally belongs to one reader:
    /// a reconnect must still recover any message that was never acknowledged.
    fn accept(&mut self, server_msg: &AgentInstanceServerMessage) -> bool {
        let key = match server_msg {
            AgentInstanceServerMessage::ChannelMessageReceived { message, .. }
            | AgentInstanceServerMessage::ChannelHistoryReplay { message, .. } => {
                (message.channel_id.clone(), message.message_id.clone())
            }
            _ => return true,
        };
        if !self.keys.insert(key.clone()) {
            return false;
        }
        self.order.push_back(key);
        if self.order.len() > CHANNEL_DELIVERY_DEDUP_CAPACITY
            && let Some(expired) = self.order.pop_front()
        {
            self.keys.remove(&expired);
        }
        true
    }
}

fn spawn_reader(mut read: WsRead, ctx: ReaderContext) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut delivery_deduper = ChannelDeliveryDeduper::default();
        while let Some(result) = read.next().await {
            if ctx
                .signals
                .generation
                .load(std::sync::atomic::Ordering::Acquire)
                != ctx.generation_id
            {
                return;
            }
            let msg = match result {
                Ok(m) => m,
                Err(_) => break,
            };
            let text = match msg {
                Message::Text(text) => text.to_string(),
                Message::Close(frame) => {
                    let reason = frame
                        .as_ref()
                        .map(|frame| frame.reason.to_string())
                        .unwrap_or_default();
                    if http::is_upgrade_required_close(frame.as_ref()) {
                        ctx.signals
                            .intentional_close
                            .store(true, std::sync::atomic::Ordering::Release);
                        let message = if reason.is_empty() {
                            "This xMatrix daemon must be updated before reconnecting.".into()
                        } else {
                            reason
                        };
                        let _ = ctx.event_tx.send(AgentInstanceConnectionEvent::Server(
                            AgentInstanceServerMessage::ShutdownRequested {
                                reason: Some(message),
                            },
                        ));
                        return;
                    }
                    if is_remote_shutdown_close_reason(&reason) {
                        ctx.shutdown(AgentInstanceServerMessage::ShutdownRequested {
                            reason: Some(reason),
                        });
                        return;
                    }
                    break;
                }
                _ => continue,
            };
            ctx.last_server_activity_ms
                .store(now_ms(), std::sync::atomic::Ordering::Release);
            let server_msg: AgentInstanceServerMessage = match serde_json::from_str(&text) {
                Ok(m) => m,
                Err(_) => continue,
            };
            if !delivery_deduper.accept(&server_msg) {
                continue;
            }
            if let AgentInstanceServerMessage::Error {
                message,
                request_id,
                ..
            } = &server_msg
                && durable_object_runtime_reset(message)
            {
                if let Some(request_id) = request_id {
                    let mut guard = ctx.pending.lock().await;
                    if let Some(tx) = guard.remove(request_id) {
                        let _ = tx.send(server_msg.clone());
                    }
                } else {
                    let _ = ctx
                        .event_tx
                        .send(AgentInstanceConnectionEvent::Server(server_msg.clone()));
                }
                break;
            }
            if let AgentInstanceServerMessage::TraceHistoryRequested {
                request_id,
                instance_id,
                max_events,
                since,
                before,
                max_bytes,
                wait_ms,
            } = &server_msg
            {
                let read = TraceHistoryRead {
                    request_id: request_id.clone(),
                    instance_id: instance_id.clone(),
                    max_events: *max_events as usize,
                    max_bytes: max_bytes.map(|bytes| bytes as usize),
                    since: since.clone(),
                    before: before.clone(),
                };
                // Only a live `since` delta waits; paging and head reads answer now.
                let wait = wait_ms
                    .filter(|_| since.is_some() && before.is_none())
                    .map(|ms| {
                        std::time::Duration::from_millis(u64::from(
                            ms.min(TRACE_HISTORY_MAX_WAIT_MS),
                        ))
                    })
                    .filter(|wait| !wait.is_zero());
                match wait {
                    Some(wait) if try_start_trace_wait(&ctx.trace_waits) => {
                        let store = ctx.trace_store.clone();
                        let write_tx = ctx.write_tx.clone();
                        let waits = ctx.trace_waits.clone();
                        tokio::spawn(async move {
                            let history = wait_for_trace_history(&store, &read, wait).await;
                            waits.fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
                            let _ = send_trace_history_response(&write_tx, &read.response(history))
                                .await;
                        });
                    }
                    _ => {
                        let history = read_trace_history(&ctx.trace_store, &read);
                        let _ = send_trace_history_response(&ctx.write_tx, &read.response(history))
                            .await;
                    }
                }
                continue;
            }
            if matches!(
                &server_msg,
                AgentInstanceServerMessage::ShutdownRequested { .. }
            ) {
                ctx.shutdown(server_msg);
                return;
            }
            // Both frame kinds are unpacked here: a summon echo reaches this
            // instance as history replay, never as live delivery.
            if let AgentInstanceServerMessage::ChannelMessageReceived { message, .. }
            | AgentInstanceServerMessage::ChannelHistoryReplay { message, .. } = &server_msg
            {
                let (message_id, channel_id, sequence) =
                    (&message.message_id, &message.channel_id, &message.sequence);
                let own_author = ctx
                    .registered_author
                    .lock()
                    .ok()
                    .and_then(|author| author.clone());
                if delivery_is_acknowledged_and_dropped(
                    &server_msg,
                    own_author.as_ref(),
                    ctx.spawn_initial_message_id.as_deref(),
                ) {
                    // Ack it so the hub's durable cursor still advances;
                    // otherwise reconnect replay would resurrect it forever.
                    let ack = AgentInstanceClientMessage::ChannelMessageAck {
                        message_id: message_id.clone(),
                        channel_id: channel_id.clone(),
                        sequence: *sequence,
                    };
                    remember_last_channel_ack(&ctx.last_channel_acks, &ack);
                    if let Ok(json) = serde_json::to_string(&ack) {
                        let _ = ctx.write_tx.try_send(json);
                    }
                    advance_channel_waterline(
                        &ctx.channel_waterlines,
                        channel_id.clone(),
                        *sequence,
                    );
                    continue;
                }
            }
            remember_channel_waterline(&ctx.channel_waterlines, &server_msg);

            let request_id = server_message_request_id(&server_msg);
            if let Some(rid) = request_id {
                let mut guard = ctx.pending.lock().await;
                if let Some(tx) = guard.remove(&rid) {
                    let _ = tx.send(server_msg);
                }
                continue;
            }

            let _ = ctx
                .event_tx
                .send(AgentInstanceConnectionEvent::Server(server_msg));
        }

        // Connection lost
        if ctx
            .signals
            .generation
            .load(std::sync::atomic::Ordering::Acquire)
            == ctx.generation_id
            && !ctx
                .signals
                .intentional_close
                .load(std::sync::atomic::Ordering::Acquire)
        {
            signal_disconnect(
                ctx.generation_id,
                &ctx.signals.generation,
                &ctx.signals.intentional_close,
                &ctx.signals.disconnect_notify,
                &ctx.signals.disconnect_generation,
                &ctx.event_tx,
                "WebSocket read stream ended".into(),
            );
        }
    })
}

/// Build a message that Relay authority can persist without weakening its append
/// contract. Recipient acknowledgement is a live-delivery concern and is not
/// represented by the Authority append command.
fn authority_compatible_channel_message(
    channel_id: String,
    body: String,
) -> AgentInstanceClientMessage {
    AgentInstanceClientMessage::ChannelMessage {
        request_id: None,
        channel_id,
        body,
        // TODO(reply): expose a CLI/app-server reply path that can pass
        // the inbound message id back as `replyToMessageId`.
        reply_to_message_id: None,
        app_mentions: None,
        metadata: None,
    }
}

fn server_message_request_id(server_msg: &AgentInstanceServerMessage) -> Option<String> {
    match server_msg {
        AgentInstanceServerMessage::Error { request_id, .. } => request_id.clone(),
        AgentInstanceServerMessage::Pong { request_id, .. } => request_id.clone(),
        AgentInstanceServerMessage::Unregistered { request_id, .. } => request_id.clone(),
        AgentInstanceServerMessage::ChannelJoined { request_id, .. } => request_id.clone(),
        AgentInstanceServerMessage::ChannelLeft { request_id, .. } => request_id.clone(),
        AgentInstanceServerMessage::ChannelHistory { request_id, .. } => request_id.clone(),
        AgentInstanceServerMessage::ChannelMessageDispatched { request_id, .. } => {
            request_id.clone()
        }
        _ => None,
    }
}

fn remember_channel_waterline(
    channel_waterlines: &Arc<Mutex<HashMap<String, u64>>>,
    server_msg: &AgentInstanceServerMessage,
) {
    let update = match server_msg {
        AgentInstanceServerMessage::ChannelHistory {
            channel_id,
            messages,
            ..
        } => messages
            .iter()
            .filter_map(|message| message.sequence)
            .max()
            .map(|sequence| (channel_id.clone(), sequence)),
        _ => None,
    };
    let Some((channel_id, sequence)) = update else {
        return;
    };
    advance_channel_waterline(channel_waterlines, channel_id, Some(sequence));
}

/// Records the newest ack per channel so a reconnect can replay it.
///
/// Only a strictly greater sequence replaces the stored ack: acks for a channel
/// are not ordered against each other once several are in flight, and a stale
/// one must not overwrite a newer mark.
fn remember_last_channel_ack(
    last_channel_acks: &Arc<Mutex<HashMap<String, AgentInstanceClientMessage>>>,
    ack: &AgentInstanceClientMessage,
) {
    let AgentInstanceClientMessage::ChannelMessageAck {
        channel_id,
        sequence,
        ..
    } = ack
    else {
        return;
    };
    // Authority folds acks by sequence, so one without a sequence cannot move the
    // cursor and is not worth replaying.
    let Some(sequence) = *sequence else {
        return;
    };
    let Ok(mut acks) = last_channel_acks.lock() else {
        return;
    };
    let newer = match acks.get(channel_id) {
        Some(AgentInstanceClientMessage::ChannelMessageAck {
            sequence: Some(stored),
            ..
        }) => sequence > *stored,
        _ => true,
    };
    if newer {
        acks.insert(channel_id.clone(), ack.clone());
    }
}

/// Replays the newest ack per channel onto a freshly connected writer.
///
/// Returns how many were sent so a test can prove the convergence happened.
fn replay_last_channel_acks(
    last_channel_acks: &Arc<Mutex<HashMap<String, AgentInstanceClientMessage>>>,
    write_tx: &mpsc::Sender<String>,
) -> usize {
    let acks: Vec<AgentInstanceClientMessage> = match last_channel_acks.lock() {
        Ok(acks) => acks.values().cloned().collect(),
        Err(_) => return 0,
    };
    let mut sent = 0;
    for ack in acks {
        // Kept on failure rather than dropped: the next reconnect replays it
        // again, and Authority discards it as soon as the cursor is already ahead.
        if let Ok(json) = serde_json::to_string(&ack)
            && write_tx.try_send(json).is_ok()
        {
            sent += 1;
        }
    }
    sent
}

/// Bounded so a long outage cannot grow the queue without limit; the hub's
/// durable cursor still recovers anything evicted here.
const PENDING_ACK_LIMIT: usize = 512;

fn queue_pending_ack(
    pending_acks: &Arc<Mutex<VecDeque<AgentInstanceClientMessage>>>,
    ack: AgentInstanceClientMessage,
) {
    let Ok(mut queue) = pending_acks.lock() else {
        return;
    };
    if queue.len() >= PENDING_ACK_LIMIT {
        queue.pop_front();
    }
    queue.push_back(ack);
}

/// Replays queued acks onto a freshly connected writer, oldest first, so the
/// hub's channel cursor catches up before catch-up replay is requested.
fn flush_pending_acks(
    pending_acks: &Arc<Mutex<VecDeque<AgentInstanceClientMessage>>>,
    write_tx: &mpsc::Sender<String>,
) -> usize {
    let queued: Vec<AgentInstanceClientMessage> = match pending_acks.lock() {
        Ok(mut queue) => queue.drain(..).collect(),
        Err(_) => return 0,
    };
    let mut flushed = 0;
    for (index, ack) in queued.iter().enumerate() {
        let Ok(json) = serde_json::to_string(ack) else {
            continue;
        };
        if write_tx.try_send(json).is_err() {
            // The replacement writer is already saturated or gone: keep the
            // remaining acks for the next reconnect rather than losing them.
            if let Ok(mut queue) = pending_acks.lock() {
                for pending in queued[index..].iter().rev() {
                    queue.push_front(pending.clone());
                }
            }
            break;
        }
        flushed += 1;
    }
    flushed
}

fn advance_channel_waterline(
    channel_waterlines: &Arc<Mutex<HashMap<String, u64>>>,
    channel_id: String,
    sequence: Option<u64>,
) {
    let Some(sequence) = sequence else {
        return;
    };
    if let Ok(mut waterlines) = channel_waterlines.lock() {
        let current = waterlines.entry(channel_id).or_insert(0);
        *current = (*current).max(sequence);
    }
}

fn is_remote_shutdown_close_reason(reason: &str) -> bool {
    reason.starts_with("Stopped from xMatrix") || reason == "Session expired"
}

fn metadata_with_previous_instance_id(
    metadata: Option<serde_json::Value>,
    agent: &SerializedAgent,
) -> Option<serde_json::Value> {
    let Some(instance_id) = agent.instance_id.as_ref() else {
        return metadata;
    };
    metadata_with_previous_instance_id_value(metadata, instance_id)
}

fn metadata_with_persisted_previous_instance_id(
    metadata: Option<serde_json::Value>,
    resume_key: Option<&str>,
) -> Option<serde_json::Value> {
    if metadata_string(metadata.as_ref(), "previousInstanceId").is_some() {
        return metadata;
    }
    let Some(instance_id) = load_persisted_instance_id(resume_key) else {
        return metadata;
    };
    metadata_with_previous_instance_id_value(metadata, &instance_id)
}

fn metadata_with_previous_instance_id_value(
    metadata: Option<serde_json::Value>,
    instance_id: &str,
) -> Option<serde_json::Value> {
    let instance_id = instance_id.trim();
    if instance_id.is_empty() {
        return metadata;
    }
    let mut metadata = metadata.unwrap_or_else(|| serde_json::json!({}));
    if let serde_json::Value::Object(object) = &mut metadata {
        object.insert(
            "previousInstanceId".to_string(),
            serde_json::Value::String(instance_id.to_string()),
        );
        Some(metadata)
    } else {
        Some(serde_json::json!({ "previousInstanceId": instance_id }))
    }
}

fn metadata_string(metadata: Option<&serde_json::Value>, key: &str) -> Option<String> {
    let value = metadata?.as_object()?.get(key)?;
    value
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn instance_resume_key(
    relay_url: &str,
    agent_id: Option<&str>,
    agent_name: &str,
    agent_type: &str,
    metadata: Option<&serde_json::Value>,
) -> Option<String> {
    instance_resume_key_with_headless(
        relay_url,
        agent_id,
        agent_name,
        agent_type,
        metadata,
        std::env::var("XMATRIX_HEADLESS").ok().is_some(),
    )
}

fn instance_resume_key_with_headless(
    relay_url: &str,
    agent_id: Option<&str>,
    agent_name: &str,
    agent_type: &str,
    metadata: Option<&serde_json::Value>,
    headless: bool,
) -> Option<String> {
    if headless {
        return None;
    }
    let channel_id = metadata_string(metadata, "autoJoinChannelId");
    let workspace = metadata_string(metadata, "workspaceCwd")
        .or_else(|| metadata_string(metadata, "cwd"))
        .or_else(|| metadata_string(metadata, "canonicalCwd"));
    let machine_id = metadata_string(metadata, "machineId")?;
    let identity = agent_id
        .map(str::to_string)
        .unwrap_or_else(|| format!("{agent_type}:{agent_name}"));
    Some(
        [
            relay_url.trim().to_string(),
            identity,
            channel_id.unwrap_or_default(),
            workspace.unwrap_or_default(),
            machine_id,
        ]
        .join("\0"),
    )
}

fn instance_resume_path(key: &str) -> PathBuf {
    let mut digest = 0xcbf29ce484222325u64;
    for byte in key.as_bytes() {
        digest ^= u64::from(*byte);
        digest = digest.wrapping_mul(0x100000001b3);
    }
    config::profile_state_dir()
        .join("instance-resume")
        .join(format!("{digest:016x}.instance"))
}

fn load_persisted_instance_id(key: Option<&str>) -> Option<String> {
    let key = key?.trim();
    if key.is_empty() {
        return None;
    }
    std::fs::read_to_string(instance_resume_path(key))
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn save_persisted_instance_id(key: Option<&str>, instance_id: Option<&str>) {
    let Some(key) = key.map(str::trim).filter(|value| !value.is_empty()) else {
        return;
    };
    let Some(instance_id) = instance_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return;
    };
    let path = instance_resume_path(key);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, instance_id);
}

fn clear_persisted_instance_id(key: Option<&str>) {
    let Some(key) = key.map(str::trim).filter(|value| !value.is_empty()) else {
        return;
    };
    let _ = std::fs::remove_file(instance_resume_path(key));
}

fn spawn_ping(
    write_tx: mpsc::Sender<String>,
    generation_id: u64,
    last_server_activity_ms: std::sync::Arc<std::sync::atomic::AtomicU64>,
    signals: ConnectionSignals,
    event_tx: mpsc::UnboundedSender<AgentInstanceConnectionEvent>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut next_delay_ms = HEARTBEAT_INTERVAL_MS;
        let mut awaiting_since_ms: Option<u64> = None;

        loop {
            tokio::time::sleep(std::time::Duration::from_millis(next_delay_ms)).await;

            if signals
                .generation
                .load(std::sync::atomic::Ordering::Acquire)
                != generation_id
            {
                return;
            }

            let last_activity_ms =
                last_server_activity_ms.load(std::sync::atomic::Ordering::Acquire);
            let silence_ms = now_ms().saturating_sub(last_activity_ms);

            if silence_ms >= HEARTBEAT_TIMEOUT_MS {
                // Heartbeat timeout — connection is dead
                signals.disconnect(
                    generation_id,
                    &event_tx,
                    format!("No server activity for {silence_ms}ms"),
                );
                return;
            }

            if let Some(waiting_since_ms) = awaiting_since_ms
                && last_activity_ms > waiting_since_ms
            {
                awaiting_since_ms = None;
                next_delay_ms = HEARTBEAT_INTERVAL_MS;
                continue;
            }

            let ping = AgentInstanceClientMessage::Ping {
                request_id: Some(uuid::Uuid::new_v4().to_string()),
            };
            if let Ok(json) = serde_json::to_string(&ping)
                && write_tx.try_send(json).is_err()
            {
                signals.disconnect(generation_id, &event_tx, "Write channel closed".into());
                return;
            }

            awaiting_since_ms = Some(last_activity_ms);
            next_delay_ms = match awaiting_since_ms {
                Some(_) if next_delay_ms >= HEARTBEAT_INTERVAL_MS => HEARTBEAT_RETRY_BASE_MS,
                Some(_) => (next_delay_ms.saturating_mul(2)).min(HEARTBEAT_RETRY_MAX_MS),
                None => HEARTBEAT_INTERVAL_MS,
            };
        }
    })
}

fn emit_client_network_samples(
    relay_url: &str,
    token: &Arc<RwLock<String>>,
    history_channels: &Arc<Mutex<HashSet<String>>>,
    mode: &'static str,
    network_state: &'static str,
    result: &'static str,
    latency_ms: Option<u64>,
    reconnect_attempt: Option<u32>,
    last_server_activity_age_ms: Option<u64>,
    reason: Option<String>,
) {
    let channels: Vec<String> = history_channels
        .lock()
        .map(|history| {
            history
                .iter()
                .take(CLIENT_NETWORK_SAMPLE_MAX_CHANNELS)
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    if channels.is_empty() {
        return;
    }

    let token_value = match token.read() {
        Ok(token) => token.clone(),
        Err(_) => return,
    };
    let url = with_route(
        &derive_http_base_url(relay_url),
        HubRoutes::OBSERVABLE_CLIENT_METRICS,
    );
    let reason = reason.map(|value| {
        value
            .chars()
            .take(CLIENT_NETWORK_REASON_MAX_CHARS)
            .collect::<String>()
    });

    tokio::spawn(async move {
        for channel_id in channels {
            let mut body = serde_json::json!({
                "clientKind": "cli",
                "mode": mode,
                "networkState": network_state,
                "result": result,
                "channelId": channel_id,
            });
            if let Some(latency_ms) = latency_ms {
                body["latencyMs"] = serde_json::json!(latency_ms);
            }
            if let Some(reconnect_attempt) = reconnect_attempt {
                body["reconnectAttempt"] = serde_json::json!(reconnect_attempt);
            }
            if let Some(last_server_activity_age_ms) = last_server_activity_age_ms {
                body["lastServerActivityAgeMs"] = serde_json::json!(last_server_activity_age_ms);
            }
            if let Some(reason) = &reason {
                body["reason"] = serde_json::json!(reason);
            }

            if http::request_json::<serde_json::Value>(&url, "POST", Some(&token_value), Some(body))
                .await
                .is_err()
            {
                let now = now_ms();
                if should_log_client_network_sample_failure(
                    now,
                    &LAST_CLIENT_NETWORK_SAMPLE_FAILURE_LOG_MS,
                ) {
                    eprintln!(
                        "{} xMatrix client network telemetry upload failed; later failures are suppressed for 60s",
                        trace_timestamp_now()
                    );
                }
            }
        }
    });
}

fn should_log_client_network_sample_failure(now_ms: u64, last_log_ms: &AtomicU64) -> bool {
    let last = last_log_ms.load(Ordering::Relaxed);
    now_ms.saturating_sub(last) >= CLIENT_NETWORK_SAMPLE_FAILURE_LOG_INTERVAL_MS
        && last_log_ms
            .compare_exchange(last, now_ms, Ordering::Relaxed, Ordering::Relaxed)
            .is_ok()
}

pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
pub(crate) mod tests {
    mod agent_socket_fixture {
        include!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/support/agent_socket_fixture.rs"
        ));
    }

    use std::collections::{HashMap, VecDeque};
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    };

    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        sync::{Notify, mpsc},
    };

    use crate::agent_trace_store::{
        AgentHostTraceAvailability, AgentHostTraceStore, HOST_TRACE_MAX_AGE_MS,
    };
    use crate::protocol::{
        AgentGoalStatus, AgentInstanceClientMessage, AgentInstanceServerMessage, AgentRuntimeState,
        LlmQuotaUsage, LlmUsage, SerializedAgent,
    };

    use crate::agent_instance_delivery::tests::{replay_frame, test_channel_message};

    use super::{
        AgentInstanceConnectionClient, AgentInstanceConnectionEvent, ChannelDeliveryDeduper,
        TRACE_REAP_INTERVAL_MS, advance_channel_waterline, authority_compatible_channel_message,
        flush_pending_acks, install_connected_writer, instance_resume_key_with_headless,
        is_remote_shutdown_close_reason, metadata_with_previous_instance_id_value, now_ms,
        queue_pending_ack, reconnect_channel_catchup_message, remember_channel_waterline,
        remember_last_channel_ack, replay_last_channel_acks, send_trace_history_response,
        server_message_request_id, should_log_client_network_sample_failure, signal_disconnect,
        spawn_trace_reaper, terminal_reconnect_rejection,
    };
    use std::time::Duration;

    #[test]
    fn client_network_sample_failure_logs_are_rate_limited() {
        let last_log_ms = AtomicU64::new(0);
        assert!(!should_log_client_network_sample_failure(
            59_999,
            &last_log_ms
        ));
        assert!(should_log_client_network_sample_failure(
            60_000,
            &last_log_ms
        ));
        assert!(!should_log_client_network_sample_failure(
            60_001,
            &last_log_ms
        ));
        assert!(should_log_client_network_sample_failure(
            120_000,
            &last_log_ms
        ));
    }

    async fn read_test_http_request(stream: &mut tokio::net::TcpStream) -> String {
        let mut request = Vec::new();
        let mut buffer = [0_u8; 1_024];
        loop {
            let read = stream.read(&mut buffer).await.unwrap();
            assert!(read > 0, "HTTP request closed before its body");
            request.extend_from_slice(&buffer[..read]);
            let Some(header_end) = request.windows(4).position(|window| window == b"\r\n\r\n")
            else {
                continue;
            };
            let headers = String::from_utf8_lossy(&request[..header_end + 4]);
            let content_length = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().unwrap())
                })
                .unwrap_or(0);
            if request.len() >= header_end + 4 + content_length {
                return String::from_utf8(request).unwrap();
            }
        }
    }

    #[test]
    fn agent_connection_url_discards_machine_paths() {
        assert_eq!(
            super::derive_connection_url("wss://hub.example.com/ws/machine-daemons?stale=1"),
            "wss://hub.example.com/ws/agent-instances"
        );
        assert_eq!(
            super::derive_http_base_url("wss://hub.example.com/ws/agent-instances"),
            "https://hub.example.com"
        );
    }

    async fn attachment_test_listener() -> (tokio::net::TcpListener, std::net::SocketAddr) {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        (listener, address)
    }

    fn presence_test_client() -> Arc<AgentInstanceConnectionClient> {
        Arc::new(AgentInstanceConnectionClient::new(
            "ws://127.0.0.1:1/ws/agent-instances".into(),
            "token".into(),
            "claude".into(),
            "claude_code".into(),
            None,
        ))
    }

    async fn pending_default_presence_commit() -> (
        Arc<AgentInstanceConnectionClient>,
        mpsc::Receiver<String>,
        tokio::task::JoinHandle<crate::error::Result<()>>,
    ) {
        let client = presence_test_client();
        let (writer, mut frames) = mpsc::channel(4);
        *client.write_tx.lock().unwrap() = Some(writer);
        let requester = client.clone();
        let commit = tokio::spawn(async move {
            requester
                .commit_presence(super::AgentPresenceSnapshot::default().message())
                .await
        });
        // Observe both the presence update and its correlated commit fence.
        frames.recv().await.unwrap();
        frames.recv().await.unwrap();
        (client, frames, commit)
    }

    #[tokio::test]
    async fn presence_commit_requires_correlated_pong_on_the_same_connection() {
        for scenario in [
            "committed",
            "refused",
            "reconnected",
            "queue-full",
            "offline",
        ] {
            let client = presence_test_client();
            let (writer, mut frames) = mpsc::channel(if scenario == "queue-full" { 1 } else { 4 });
            if scenario != "offline" {
                *client.write_tx.lock().unwrap() = Some(writer);
            }
            let requester = client.clone();
            let commit = tokio::spawn(async move {
                requester
                    .commit_presence(
                        super::AgentPresenceSnapshot {
                            model: Some("claude-observed".into()),
                            effort: Some("medium".into()),
                            ..Default::default()
                        }
                        .message(),
                    )
                    .await
            });
            if scenario == "offline" || scenario == "queue-full" {
                assert!(commit.await.unwrap().is_err());
                assert!(client.pending.lock().await.is_empty());
                continue;
            }
            let presence: serde_json::Value =
                serde_json::from_str(&frames.recv().await.unwrap()).unwrap();
            let ping: serde_json::Value =
                serde_json::from_str(&frames.recv().await.unwrap()).unwrap();
            assert_eq!(presence["type"], "presence_update");
            assert_eq!(ping["type"], "ping");
            assert_eq!(presence["requestId"], ping["requestId"]);
            assert!(!commit.is_finished(), "an enqueued frame is not a commit");
            let id = ping["requestId"].as_str().unwrap().to_string();
            if scenario == "reconnected" {
                client
                    .generation
                    .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
            }
            let response = if scenario == "refused" {
                AgentInstanceServerMessage::Error {
                    request_id: Some(id.clone()),
                    message: "presentation refused".into(),
                    failure: None,
                }
            } else {
                AgentInstanceServerMessage::Pong {
                    request_id: Some(id.clone()),
                    ts: "2026-10-03T23:00:00Z".into(),
                }
            };
            client
                .pending
                .lock()
                .await
                .remove(&id)
                .unwrap()
                .send(response)
                .unwrap();
            assert_eq!(commit.await.unwrap().is_ok(), scenario == "committed");
            assert!(client.pending.lock().await.is_empty());
        }
    }

    #[tokio::test]
    async fn cancelling_presence_commit_retires_its_waiter() {
        let (client, _frames, commit) = pending_default_presence_commit().await;
        assert_eq!(client.pending.lock().await.len(), 1);
        commit.abort();
        assert!(commit.await.unwrap_err().is_cancelled());
        assert!(client.pending.lock().await.is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn a_stalled_presence_commit_expires_its_waiter() {
        let (client, _frames, commit) = pending_default_presence_commit().await;
        tokio::time::advance(std::time::Duration::from_millis(
            super::REQUEST_TIMEOUT_MS + 1,
        ))
        .await;
        assert!(
            commit
                .await
                .unwrap()
                .unwrap_err()
                .to_string()
                .contains("timed out")
        );
        assert!(client.pending.lock().await.is_empty());
    }

    #[tokio::test]
    async fn attachment_download_rejects_a_channel_outside_the_run_binding() {
        let client = AgentInstanceConnectionClient::new(
            "http://127.0.0.1:1".into(),
            "run-token".into(),
            "builder".into(),
            "codex".into(),
            None,
        );

        let error = client
            .download_channel_attachment("channel-other", "message-1", "attachment-1", 3)
            .await
            .expect_err("foreign-channel reads must fail before HTTP");

        assert!(error.to_string().contains("outside the Agent run binding"));
    }

    #[tokio::test]
    async fn allow_attachment_download_channel_seeds_client_gate_without_clearing() {
        let client = AgentInstanceConnectionClient::new(
            "http://127.0.0.1:1".into(),
            "run-token".into(),
            "builder".into(),
            "codex".into(),
            None,
        );
        client.allow_attachment_download_channel("birth-channel");
        client.allow_attachment_download_channel("thread-root-channel");
        client.allow_attachment_download_channel("  ");
        let channels = client.history_channels.lock().unwrap().clone();
        assert!(channels.contains("birth-channel"));
        assert!(channels.contains("thread-root-channel"));
        assert_eq!(channels.len(), 2);

        // join_channel formerly cleared the set; seed must survive so Hub-issued
        // attachment coordinates remain downloadable after auto-join.
        if let Ok(mut history) = client.history_channels.lock() {
            history.insert("birth-channel".into());
        }
        assert!(
            client
                .history_channels
                .lock()
                .unwrap()
                .contains("thread-root-channel")
        );
    }

    async fn assert_png_attachment_download(address: std::net::SocketAddr) {
        let client = AgentInstanceConnectionClient::new(
            format!("ws://{address}/ws/agent-instances"),
            "run-token".into(),
            "builder".into(),
            "codex".into(),
            None,
        );
        client
            .history_channels
            .lock()
            .unwrap()
            .insert("channel-1".into());

        let download = client
            .download_channel_attachment("channel-1", "message-1", "attachment-1", 3)
            .await
            .unwrap();

        assert_eq!(download.mime_type, "image/png");
        assert_eq!(download.bytes, b"PNG");
    }

    #[tokio::test]
    async fn attachment_download_uses_the_run_token_and_exact_owner_coordinates() {
        let (listener, address) = attachment_test_listener().await;
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let request = read_test_http_request(&mut stream).await;
            assert!(
                request.starts_with(
                    "POST /api/relay-v2/message-attachments/product-media HTTP/1.1\r\n"
                )
            );
            assert!(
                request
                    .to_ascii_lowercase()
                    .contains("\r\nauthorization: bearer run-token\r\n")
            );
            assert!(request.contains(
                r#"{"attachmentId":"attachment-1","channelId":"channel-1","messageId":"message-1"}"#
            ));
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\ncontent-type: image/png\r\ncontent-length: 3\r\nconnection: close\r\n\r\nPNG",
                )
                .await
                .unwrap();
        });
        assert_png_attachment_download(address).await;
        server.await.unwrap();
    }

    #[tokio::test]
    async fn attachment_download_retries_a_transient_not_found_response() {
        let (listener, address) = attachment_test_listener().await;
        let server = tokio::spawn(async move {
            for attempt in 0..3 {
                let (mut stream, _) = listener.accept().await.unwrap();
                read_test_http_request(&mut stream).await;
                if attempt < 2 {
                    stream
                        .write_all(
                            b"HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
                        )
                        .await
                        .unwrap();
                } else {
                    stream
                        .write_all(
                            b"HTTP/1.1 200 OK\r\ncontent-type: image/png\r\ncontent-length: 3\r\nconnection: close\r\n\r\nPNG",
                        )
                        .await
                        .unwrap();
                }
            }
        });
        assert_png_attachment_download(address).await;
        server.await.unwrap();
    }

    pub(crate) fn trace_test_agent(instance_id: &str) -> SerializedAgent {
        SerializedAgent {
            id: "agent:1".into(),
            instance_id: Some(instance_id.into()),
            user_id: "owner:1".into(),
            name: "builder".into(),
            agent_type: "codex".into(),
            lifetime: None,
            email: "owner@example.test".into(),
            metadata: serde_json::json!({}),
            connected_at: "2026-07-20T00:00:00Z".into(),
            last_seen_at: "2026-07-20T00:00:00Z".into(),
            status: "online".into(),
            avatar_url: None,
            runtime_state: None,
            model: None,
            usage: None,
            instances: None,
        }
    }

    #[tokio::test]
    async fn trace_history_response_waits_for_a_busy_writer_instead_of_dropping() {
        let (write_tx, mut write_rx) = mpsc::channel(1);
        write_tx.send("busy".into()).await.unwrap();
        let response = AgentInstanceClientMessage::TraceHistoryResult {
            request_id: "request:1".into(),
            instance_id: "instance:1".into(),
            availability: "available".into(),
            complete: true,
            events: Vec::new(),
            next_cursor: None,
        };
        let sender =
            tokio::spawn(async move { send_trace_history_response(&write_tx, &response).await });

        tokio::task::yield_now().await;
        assert!(!sender.is_finished());
        assert_eq!(write_rx.recv().await.as_deref(), Some("busy"));
        assert!(sender.await.unwrap());
        let delivered = write_rx.recv().await.unwrap();
        assert!(delivered.contains("trace_history_result"));
        assert!(delivered.contains("request:1"));
    }

    /// End to end over a real WebSocket: a Hub asks for a live delta with a
    /// wait, and the host answers only once the Agent publishes a newer step.
    #[tokio::test]
    async fn a_waiting_trace_read_over_the_socket_answers_when_the_agent_publishes() {
        use futures_util::{SinkExt as _, StreamExt as _};
        let agent = trace_test_agent("instance:1");
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (asked_tx, asked_rx) = tokio::sync::oneshot::channel::<std::time::Instant>();
        let (answer_tx, answer_rx) =
            tokio::sync::oneshot::channel::<(std::time::Instant, serde_json::Value)>();
        let hub_agent = agent.clone();
        tokio::spawn(async move {
            let mut socket = agent_socket_fixture::registered_agent_socket(
                &listener,
                AgentInstanceServerMessage::AgentInstanceConnected {
                    agent: hub_agent,
                    peers: Vec::new(),
                    hub_capabilities: Some(vec!["channel_activity".into()]),
                },
            )
            .await;
            let request =
                serde_json::to_string(&AgentInstanceServerMessage::TraceHistoryRequested {
                    request_id: "request:wait".into(),
                    instance_id: "instance:1".into(),
                    max_events: 500,
                    since: Some("2026-07-20T00:00:01Z".into()),
                    before: None,
                    max_bytes: None,
                    wait_ms: Some(10_000),
                })
                .unwrap();
            // Give the host a moment to bind its trace session and record the baseline.
            tokio::time::sleep(Duration::from_millis(100)).await;
            socket
                .send(tokio_tungstenite::tungstenite::Message::Text(
                    request.into(),
                ))
                .await
                .unwrap();
            let _ = asked_tx.send(std::time::Instant::now());
            while let Some(Ok(message)) = socket.next().await {
                let Ok(text) = message.into_text() else {
                    continue;
                };
                let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
                    continue;
                };
                if value["type"] == "trace_history_result" {
                    let _ = answer_tx.send((std::time::Instant::now(), value));
                    break;
                }
            }
        });

        let mut client = AgentInstanceConnectionClient::new(
            format!("ws://{address}/ws/agent-instances"),
            "token".into(),
            "builder".into(),
            "codex".into(),
            None,
        );
        client.register().await.expect("fake hub registration");
        // What the Hub listed on connect is what this client may send.
        assert!(client.hub_accepts("channel_activity"));
        assert!(!client.hub_accepts("channel_unknown"));
        client
            .trace_store
            .lock()
            .unwrap()
            .bind_session(&agent, now_ms());
        let publish = |id: &str, at: &str| AgentInstanceClientMessage::EventPublish {
            request_id: None,
            channel_id: "channel:1".into(),
            event_type: "llm_trace".into(),
            payload: serde_json::json!({ "phase": "tool_call" }),
            event_id: Some(id.into()),
            timestamp: Some(at.into()),
        };
        client
            .send_message(publish("event:1", "2026-07-20T00:00:01Z"))
            .unwrap();

        let asked = asked_rx.await.unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;
        let mut answer_rx = answer_rx;
        assert!(
            answer_rx.try_recv().is_err(),
            "the host holds the read while nothing is new"
        );
        client
            .send_message(publish("event:2", "2026-07-20T00:00:02Z"))
            .unwrap();
        let (answered, value) = tokio::time::timeout(Duration::from_secs(5), answer_rx)
            .await
            .expect("answered after the new step")
            .unwrap();
        assert!(answered.duration_since(asked) >= Duration::from_millis(300));
        assert_eq!(value["requestId"], "request:wait");
        let ids: Vec<_> = value["events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|event| event["id"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(ids, ["event:2", "event:1"]);
        client.disconnect();
    }

    #[tokio::test(start_paused = true)]
    async fn timer_reaps_a_silent_paused_trace_session_with_a_controlled_clock() {
        let trace_store = Arc::new(Mutex::new(AgentHostTraceStore::default()));
        {
            let mut store = trace_store.lock().unwrap();
            store.bind_session(&trace_test_agent("instance:1"), 1_000);
            store.record(
                "channel:1",
                serde_json::json!({ "payload": { "delta": "secret" } }),
                "event:1".into(),
                "2026-07-20T00:00:00Z".into(),
                1_000,
            );
        }
        let clock = Arc::new(AtomicU64::new(1_000));
        let task_clock = clock.clone();
        let intentional_close = Arc::new(AtomicBool::new(false));
        let reaper = spawn_trace_reaper(
            trace_store.clone(),
            intentional_close,
            Arc::new(Mutex::new(None)),
            Arc::new(Mutex::new(None)),
            move || task_clock.load(Ordering::Acquire),
        );

        // Let the immediate interval tick observe the initial, unexpired time.
        tokio::task::yield_now().await;
        assert_eq!(trace_store.lock().unwrap().retained_event_count(), 1);

        clock.store(1_000 + HOST_TRACE_MAX_AGE_MS + 1, Ordering::Release);
        tokio::time::advance(std::time::Duration::from_millis(TRACE_REAP_INTERVAL_MS)).await;
        tokio::task::yield_now().await;

        let store = trace_store.lock().unwrap();
        assert_eq!(store.retained_event_count(), 0);
        assert!(store.has_expired_history());
        assert_eq!(store.current_instance_id(), Some("instance:1"));
        drop(store);
        reaper.abort();
    }

    #[test]
    fn dropping_the_connection_clears_trace_payload_and_terminalizes_ownership() {
        let client = AgentInstanceConnectionClient::new(
            "ws://localhost/ws/agent-instances".into(),
            "token".into(),
            "builder".into(),
            "codex".into(),
            None,
        );
        {
            let mut store = client.trace_store.lock().unwrap();
            store.bind_session(&trace_test_agent("instance:drop"), 1_000);
            store.record(
                "channel:1",
                serde_json::json!({ "payload": { "delta": "secret" } }),
                "event:drop".into(),
                "2026-07-20T00:00:00Z".into(),
                1_000,
            );
        }
        let trace_store = client.trace_store.clone();

        drop(client);

        let mut store = trace_store.lock().unwrap();
        assert_eq!(store.current_instance_id(), None);
        assert_eq!(store.retained_event_count(), 0);
        assert_eq!(
            store
                .history(
                    "instance:drop",
                    crate::agent_trace_store::AgentHostTraceHistoryQuery {
                        max_events: 20,
                        ..Default::default()
                    },
                    2_000
                )
                .availability,
            AgentHostTraceAvailability::Expired
        );
    }

    fn disconnect_state(
        generation_value: u64,
        intentional: bool,
    ) -> (
        Arc<AtomicU64>,
        Arc<AtomicBool>,
        Arc<Notify>,
        Arc<AtomicU64>,
        mpsc::UnboundedSender<AgentInstanceConnectionEvent>,
        mpsc::UnboundedReceiver<AgentInstanceConnectionEvent>,
    ) {
        let (tx, rx) = mpsc::unbounded_channel();
        (
            Arc::new(AtomicU64::new(generation_value)),
            Arc::new(AtomicBool::new(intentional)),
            Arc::new(Notify::new()),
            Arc::new(AtomicU64::new(0)),
            tx,
            rx,
        )
    }

    #[test]
    fn signal_disconnect_ignores_stale_generation() {
        let (generation, intentional_close, notify, disconnect_generation, tx, mut rx) =
            disconnect_state(2, false);

        signal_disconnect(
            1,
            &generation,
            &intentional_close,
            &notify,
            &disconnect_generation,
            &tx,
            "stale".into(),
        );

        assert_eq!(disconnect_generation.load(Ordering::Acquire), 0);
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn channel_history_replay_waits_for_ack_before_reconnect_waterline() {
        let waterlines = Arc::new(Mutex::new(HashMap::new()));
        let replay = replay_frame(
            test_channel_message(
                "msg-7",
                Some(7),
                "user",
                None,
                "replayed",
                "2026-05-19T00:00:00Z",
            ),
            None,
        );

        remember_channel_waterline(&waterlines, &replay);

        let waterlines_guard = waterlines.lock().unwrap();
        assert_eq!(waterlines_guard.get("ch-1"), None);
        drop(waterlines_guard);

        advance_channel_waterline(&waterlines, "ch-1".into(), Some(7));

        let waterlines = waterlines.lock().unwrap();
        assert_eq!(waterlines.get("ch-1"), Some(&7));
    }

    #[test]
    fn acks_taken_while_the_socket_is_down_are_replayed_on_the_next_writer() {
        let client = AgentInstanceConnectionClient::new(
            "ws://localhost/ws/agent-instances".into(),
            "token".into(),
            "acker".into(),
            "codex".into(),
            None,
        );

        // Disconnected: the runtime already accepted the message, so the ack is
        // held rather than lost, and the waterline still moves so catch-up asks
        // only for what this instance has not handled.
        client
            .ack_channel_message("msg-7".into(), "ch-1".into(), Some(7))
            .unwrap();
        assert_eq!(client.pending_acks.lock().unwrap().len(), 1);
        assert_eq!(
            client.channel_waterlines.lock().unwrap().get("ch-1"),
            Some(&7)
        );

        let (writer, mut receiver) = mpsc::channel(4);
        assert_eq!(flush_pending_acks(&client.pending_acks, &writer), 1);
        let flushed: serde_json::Value =
            serde_json::from_str(&receiver.try_recv().unwrap()).unwrap();
        assert_eq!(flushed["type"], "channel_message_ack");
        assert_eq!(flushed["messageId"], "msg-7");
        assert_eq!(flushed["sequence"], 7);
        assert!(client.pending_acks.lock().unwrap().is_empty());
        // A second reconnect must not resend an ack the hub already has.
        assert_eq!(flush_pending_acks(&client.pending_acks, &writer), 0);
    }

    #[test]
    fn an_ack_that_died_with_its_socket_is_replayed_on_the_next_writer() {
        let client = AgentInstanceConnectionClient::new(
            "ws://localhost/ws/agent-instances".into(),
            "token".into(),
            "acker".into(),
            "codex".into(),
            None,
        );
        let (writer, receiver) = mpsc::channel(4);
        install_connected_writer(&client.write_tx, &client.latest_presence, writer).unwrap();

        client
            .ack_channel_message("msg-7".into(), "ch-1".into(), Some(7))
            .unwrap();
        // Enqueuing onto a live writer succeeds, so the retry queue never sees
        // this ack — yet nothing here proves the frame left the socket.
        assert!(client.pending_acks.lock().unwrap().is_empty());
        // The connection dies with the frame still unsent.
        drop(receiver);

        let (next_writer, mut next_receiver) = mpsc::channel(4);
        assert_eq!(
            replay_last_channel_acks(&client.last_channel_acks, &next_writer),
            1
        );
        let replayed: serde_json::Value =
            serde_json::from_str(&next_receiver.try_recv().unwrap()).unwrap();
        assert_eq!(replayed["type"], "channel_message_ack");
        assert_eq!(replayed["sequence"], 7);
    }

    #[test]
    fn replay_carries_one_newest_ack_per_channel() {
        let acks = Arc::new(Mutex::new(HashMap::new()));
        // Out of order on purpose: several acks for one channel can be in
        // flight, and the highest must win regardless of arrival order.
        for (channel_id, sequence) in [("ch-1", 3u64), ("ch-1", 9), ("ch-1", 5), ("ch-2", 2)] {
            remember_last_channel_ack(
                &acks,
                &AgentInstanceClientMessage::ChannelMessageAck {
                    message_id: format!("{channel_id}-{sequence}"),
                    channel_id: channel_id.into(),
                    sequence: Some(sequence),
                },
            );
        }
        // A cumulative ack subsumes the ones below it, so replay is bounded by
        // the channel count rather than by how many acks were lost.
        let (writer, mut receiver) = mpsc::channel(4);
        assert_eq!(replay_last_channel_acks(&acks, &writer), 2);

        let mut by_channel = HashMap::new();
        while let Ok(json) = receiver.try_recv() {
            let frame: serde_json::Value = serde_json::from_str(&json).unwrap();
            by_channel.insert(
                frame["channelId"].as_str().unwrap().to_string(),
                frame["sequence"].as_u64().unwrap(),
            );
        }
        assert_eq!(by_channel.get("ch-1"), Some(&9));
        assert_eq!(by_channel.get("ch-2"), Some(&2));
    }

    #[test]
    fn a_saturated_writer_keeps_the_unsent_acks_in_order_for_the_next_reconnect() {
        let pending = Arc::new(Mutex::new(VecDeque::new()));
        for sequence in 1..=3u64 {
            queue_pending_ack(
                &pending,
                AgentInstanceClientMessage::ChannelMessageAck {
                    message_id: format!("msg-{sequence}"),
                    channel_id: "ch-1".into(),
                    sequence: Some(sequence),
                },
            );
        }

        // One slot: the first ack lands and the rest survive for the next writer.
        let (writer, mut receiver) = mpsc::channel(1);
        assert_eq!(flush_pending_acks(&pending, &writer), 1);
        let first: serde_json::Value = serde_json::from_str(&receiver.try_recv().unwrap()).unwrap();
        assert_eq!(first["messageId"], "msg-1");
        let queued = pending.lock().unwrap();
        assert_eq!(queued.len(), 2);
        let remaining: Vec<String> = queued
            .iter()
            .map(|ack| {
                serde_json::to_value(ack).unwrap()["messageId"]
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect();
        assert_eq!(remaining, vec!["msg-2".to_string(), "msg-3".to_string()]);
    }

    #[test]
    fn one_socket_drops_duplicate_live_and_history_delivery_by_message_identity() {
        let mut deduper = ChannelDeliveryDeduper::default();
        let message = test_channel_message(
            "message-1",
            Some(7),
            "user",
            Some("user:1"),
            "do the thing",
            "2026-08-04T00:00:00Z",
        );
        let live = AgentInstanceServerMessage::ChannelMessageReceived {
            message: message.clone(),
            client_message_id: None,
            ack_required: Some(true),
            interrupt_requested: Some(true),
            delivery_intent: None,
        };

        assert!(deduper.accept(&live));
        assert!(
            !deduper.accept(&replay_frame(message, None)),
            "a history handoff racing the live frame must not create a second runtime turn",
        );
    }

    #[test]
    fn channel_history_snapshot_updates_reconnect_waterline() {
        let waterlines = Arc::new(Mutex::new(HashMap::new()));
        let history = AgentInstanceServerMessage::ChannelHistory {
            request_id: None,
            channel_id: "ch-1".into(),
            messages: [
                ("msg-3", 3, "history", "2026-05-19T00:00:00Z"),
                ("msg-9", 9, "history latest", "2026-05-19T00:00:01Z"),
            ]
            .into_iter()
            .map(|(id, sequence, body, at)| {
                let mut message = test_channel_message(id, Some(sequence), "user", None, body, at);
                message.from.label = "Human".into();
                message.from.email = "human@example.com".into();
                message
            })
            .collect(),
        };

        remember_channel_waterline(&waterlines, &history);

        let waterlines = waterlines.lock().unwrap();
        assert_eq!(waterlines.get("ch-1"), Some(&9));
    }

    #[test]
    fn dispatched_channel_message_completes_pending_request() {
        let request_id = "request-1".to_string();
        let message = AgentInstanceServerMessage::ChannelMessageDispatched {
            request_id: Some(request_id.clone()),
            message_id: "message-1".to_string(),
            channel_id: "channel-1".to_string(),
            recipients: Vec::new(),
        };

        assert_eq!(server_message_request_id(&message), Some(request_id));
    }

    #[test]
    fn authority_compatible_channel_message_omits_live_delivery_ack_request() {
        let message = authority_compatible_channel_message(
            "channel-1".to_string(),
            "visible error".to_string(),
        );
        let json = serde_json::to_value(message).unwrap();

        assert_eq!(json["type"], "channel_message");
        assert_eq!(json["channelId"], "channel-1");
        assert_eq!(json["body"], "visible error");
        assert!(json.get("ackRequired").is_none());
    }

    #[test]
    fn reconnect_stops_only_on_a_terminal_hub_rejection() {
        let rejection = |code: &str, retryable: bool| AgentInstanceServerMessage::Error {
            request_id: None,
            message: "Agent credential does not match the live Authority run".into(),
            failure: Some(crate::protocol::AgentOperationFailure {
                code: code.into(),
                diagnostic_id: "diag_1".into(),
                retryable,
                stage: "relay.validate_binding".into(),
                origin_stage: None,
            }),
        };
        let reason = terminal_reconnect_rejection(&rejection("agent_run_binding_mismatch", false))
            .expect("a binding mismatch can never reconnect");
        assert!(reason.contains("agent_run_binding_mismatch"));
        assert!(terminal_reconnect_rejection(&rejection("agent_run_not_live", false)).is_some());
        assert!(
            terminal_reconnect_rejection(&rejection("agent_run_binding_mismatch", true)).is_none()
        );
        assert!(terminal_reconnect_rejection(&rejection("relay_unavailable", false)).is_none());
        assert!(
            terminal_reconnect_rejection(&AgentInstanceServerMessage::Error {
                request_id: None,
                message: "Agent session request could not be completed".into(),
                failure: None,
            })
            .is_none()
        );
    }

    #[test]
    fn reconnect_catchup_reestablishes_the_active_channel_before_replay() {
        let message = reconnect_channel_catchup_message("channel-1".into(), Some(41));
        let json = serde_json::to_value(message).unwrap();

        assert_eq!(json["type"], "join_channel");
        assert_eq!(json["channelId"], "channel-1");
        assert_eq!(json["historyLimit"], 0);
        assert_eq!(json["afterSequence"], 41);
    }

    #[test]
    fn quota_snapshot_does_not_regress_when_an_old_turn_reports_usage() {
        let quota = |observed: &str, percent| LlmUsage {
            quota_source: Some("provider_api".into()),
            quota_observed_at: Some(observed.into()),
            quota_usages: Some(vec![LlmQuotaUsage {
                percent: Some(percent),
                ..Default::default()
            }]),
            ..Default::default()
        };
        let mut current = Some(quota("2026-09-21T18:30:00Z", 100.0));
        let mut stale = quota("2026-09-21T18:00:00Z", 20.0);
        stale.total_tokens = Some(200);
        super::merge_usage(&mut current, &stale);
        let current = current.unwrap();
        assert_eq!(current.total_tokens, Some(200));
        assert_eq!(current.quota_usages.unwrap()[0].percent, Some(100.0));
        assert_eq!(
            current.quota_observed_at.as_deref(),
            Some("2026-09-21T18:30:00Z")
        );
    }

    #[test]
    fn stale_quota_is_removed_from_outbound_presence_but_newer_quota_recovers() {
        let client = AgentInstanceConnectionClient::new(
            "ws://localhost/ws/agent-instances".into(),
            "token".into(),
            "builder".into(),
            "codex".into(),
            None,
        );
        let message = |observed: Option<&str>, percent| {
            super::AgentPresenceSnapshot {
                usage: Some(LlmUsage {
                    total_tokens: Some(200),
                    quota_source: Some("provider_api".into()),
                    quota_observed_at: observed.map(str::to_string),
                    quota_usages: Some(vec![LlmQuotaUsage {
                        percent: Some(percent),
                        ..Default::default()
                    }]),
                    ..Default::default()
                }),
                ..Default::default()
            }
            .message()
        };
        let mut fresh = message(Some("2026-09-21T18:30:00Z"), 100.0);
        client.prepare_outbound_message(&mut fresh);
        for observed in [Some("2026-09-21T18:00:00Z"), None, Some("invalid")] {
            let mut stale = message(observed, 20.0);
            client.prepare_outbound_message(&mut stale);
            let AgentInstanceClientMessage::PresenceUpdate {
                usage: Some(usage), ..
            } = stale
            else {
                panic!("expected usage")
            };
            assert!(usage.quota_usages.is_none());
            assert!(usage.quota_observed_at.is_none());
            assert_eq!(usage.total_tokens, Some(200));
        }
        let mut recovered = message(Some("2026-09-22T02:31:00+08:00"), 10.0);
        client.prepare_outbound_message(&mut recovered);
        let latest = client.latest_presence.lock().unwrap();
        assert_eq!(
            latest
                .as_ref()
                .unwrap()
                .usage
                .as_ref()
                .unwrap()
                .quota_usages
                .as_ref()
                .unwrap()[0]
                .percent,
            Some(10.0)
        );
    }

    #[test]
    fn reconnect_replays_merged_presence_and_preserves_quota_windows() {
        let client = AgentInstanceConnectionClient::new(
            "ws://localhost/ws/agent-instances".into(),
            "token".into(),
            "builder".into(),
            "codex".into(),
            None,
        );
        let full = AgentInstanceClientMessage::PresenceUpdate {
            request_id: None,
            status: Some("busy".into()),
            activity: Some("working".into()),
            files: Some(vec!["src/main.rs".into()]),
            intent: Some("verify reconnect".into()),
            git_branch: Some("fix/reconnect".into()),
            capabilities: Some(vec!["chat".into(), "tools".into()]),
            runtime_state: Some(
                AgentRuntimeState {
                    execution: None,
                    recent_executions: Vec::new(),
                    status: "running".into(),
                    source: Some("codex".into()),
                    active_channel_id: Some("channel-1".into()),
                    active_message_id: None,
                    active_thread_id: None,
                    active_turn_id: None,
                    started_at_millis: Some(1),
                    updated_at_millis: Some(2),
                    waiting: None,
                    issue: None,
                    notice: None,
                }
                .into(),
            ),
            goal: Some(Some(AgentGoalStatus {
                active: Some(true),
                objective: Some("restore presentation".into()),
                ..Default::default()
            })),
            model: Some("gpt-5.6-sol".into()),
            models: None,
            effort: Some("xhigh".into()),
            commands: None,
            parameters: None,
            status_chips: None,
            usage: Some(
                LlmUsage {
                    input_tokens: Some(100),
                    output_tokens: Some(23),
                    total_tokens: Some(123),
                    context_used_tokens: Some(123),
                    context_window_tokens: Some(1_000),
                    context_usage_percent: Some(12.3),
                    quota_usages: Some(vec![LlmQuotaUsage {
                        label: Some("5h".into()),
                        window: Some("5h".into()),
                        used: Some(30.0),
                        limit: Some(100.0),
                        remaining: Some(70.0),
                        percent: Some(30.0),
                        reset_at: None,
                    }]),
                    ..Default::default()
                }
                .into(),
            ),
        };
        assert!(client.send_message(full).is_err());

        let token_only = AgentInstanceClientMessage::PresenceUpdate {
            request_id: None,
            status: None,
            activity: None,
            files: None,
            intent: None,
            git_branch: None,
            capabilities: None,
            runtime_state: None,
            goal: None,
            model: None,
            models: None,
            effort: None,
            commands: None,
            parameters: None,
            status_chips: None,
            usage: Some(
                LlmUsage {
                    input_tokens: Some(150),
                    output_tokens: Some(30),
                    total_tokens: Some(180),
                    ..Default::default()
                }
                .into(),
            ),
        };
        assert!(client.send_message(token_only).is_err());

        let (writer, mut receiver) = mpsc::channel(2);
        install_connected_writer(&client.write_tx, &client.latest_presence, writer).unwrap();
        let replay: serde_json::Value =
            serde_json::from_str(&receiver.try_recv().unwrap()).unwrap();
        assert_eq!(replay["type"], "presence_update");
        assert_eq!(replay["model"], "gpt-5.6-sol");
        assert_eq!(replay["effort"], "xhigh");
        assert_eq!(replay["gitBranch"], "fix/reconnect");
        assert_eq!(replay["goal"]["objective"], "restore presentation");
        assert_eq!(replay["runtimeState"]["status"], "running");
        assert_eq!(replay["usage"]["totalTokens"], 180);
        assert_eq!(replay["usage"]["contextWindowTokens"], 1_000);
        assert_eq!(replay["usage"]["quotaUsages"][0]["remaining"], 70.0);
        assert_eq!(replay["statusChips"][0]["id"], "model");
        assert_eq!(replay["statusChips"][0]["value"], "gpt-5.6-sol");
        assert_eq!(replay["statusChips"][1]["id"], "effort");
        assert_eq!(replay["statusChips"][1]["value"], "xhigh");
        assert!(client.write_tx_clone().is_some());
    }

    #[test]
    fn reconnect_snapshot_applies_explicit_goal_clear_and_idle_runtime_clear() {
        let client = AgentInstanceConnectionClient::new(
            "ws://localhost/ws/agent-instances".into(),
            "token".into(),
            "builder".into(),
            "codex".into(),
            None,
        );
        let running = AgentInstanceClientMessage::PresenceUpdate {
            request_id: None,
            status: Some("busy".into()),
            activity: None,
            files: None,
            intent: None,
            git_branch: None,
            capabilities: None,
            runtime_state: Some(
                AgentRuntimeState {
                    execution: None,
                    recent_executions: Vec::new(),
                    status: "running".into(),
                    source: None,
                    active_channel_id: None,
                    active_message_id: None,
                    active_thread_id: None,
                    active_turn_id: None,
                    started_at_millis: None,
                    updated_at_millis: None,
                    waiting: None,
                    issue: None,
                    notice: None,
                }
                .into(),
            ),
            goal: Some(Some(AgentGoalStatus {
                objective: Some("old goal".into()),
                ..Default::default()
            })),
            model: None,
            models: None,
            effort: None,
            commands: None,
            parameters: None,
            status_chips: None,
            usage: None,
        };
        assert!(client.send_message(running).is_err());
        let cleared = AgentInstanceClientMessage::PresenceUpdate {
            request_id: None,
            status: Some("idle".into()),
            activity: None,
            files: None,
            intent: None,
            git_branch: None,
            capabilities: None,
            runtime_state: None,
            goal: Some(None),
            model: None,
            models: None,
            effort: None,
            commands: None,
            parameters: None,
            status_chips: None,
            usage: None,
        };
        assert!(client.send_message(cleared).is_err());

        let replay = client
            .latest_presence
            .lock()
            .unwrap()
            .as_ref()
            .map(|snapshot| serde_json::to_value(snapshot.message()).unwrap())
            .unwrap();
        assert_eq!(replay["status"], "idle");
        assert!(replay.get("runtimeState").is_none());
        assert!(replay.get("goal").is_some_and(serde_json::Value::is_null));
    }

    #[test]
    fn signal_disconnect_ignores_intentional_close() {
        let (generation, intentional_close, notify, disconnect_generation, tx, mut rx) =
            disconnect_state(3, true);

        signal_disconnect(
            3,
            &generation,
            &intentional_close,
            &notify,
            &disconnect_generation,
            &tx,
            "closed".into(),
        );

        assert_eq!(disconnect_generation.load(Ordering::Acquire), 0);
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn signal_disconnect_emits_once_per_generation() {
        let (generation, intentional_close, notify, disconnect_generation, tx, mut rx) =
            disconnect_state(4, false);

        signal_disconnect(
            4,
            &generation,
            &intentional_close,
            &notify,
            &disconnect_generation,
            &tx,
            "first".into(),
        );
        signal_disconnect(
            4,
            &generation,
            &intentional_close,
            &notify,
            &disconnect_generation,
            &tx,
            "second".into(),
        );

        assert_eq!(disconnect_generation.load(Ordering::Acquire), 4);
        match rx.try_recv() {
            Ok(AgentInstanceConnectionEvent::Disconnected { reason }) => {
                assert_eq!(reason, "first")
            }
            other => panic!("expected one disconnect event, got {other:?}"),
        }
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn remote_shutdown_close_reason_matches_web_stop() {
        assert!(is_remote_shutdown_close_reason("Stopped from xMatrix web"));
        assert!(is_remote_shutdown_close_reason("Stopped from xMatrix"));
        assert!(is_remote_shutdown_close_reason("Session expired"));
        assert!(!is_remote_shutdown_close_reason(
            "WebSocket read stream ended"
        ));
    }

    #[test]
    fn local_trace_stays_off_the_writer_and_process_lifecycle_keeps_the_trace_session() {
        let client = AgentInstanceConnectionClient::new(
            "ws://localhost/ws/agent-instances".into(),
            "token".into(),
            "builder".into(),
            "codex".into(),
            None,
        );
        let agent = trace_test_agent("instance:1");
        client.trace_store.lock().unwrap().bind_session(&agent, 0);
        let publish = AgentInstanceClientMessage::EventPublish {
            request_id: None,
            channel_id: "channel:1".into(),
            event_type: "llm_trace".into(),
            payload: serde_json::json!({ "payload": { "delta": "secret" } }),
            event_id: None,
            timestamp: None,
        };
        let (write_tx, mut write_rx) = mpsc::channel(1);
        *client.write_tx.lock().unwrap() = Some(write_tx);
        client.send(publish).expect("local trace record");
        assert!(
            write_rx.try_recv().is_err(),
            "local trace records must not occupy the relay writer queue"
        );
        assert_eq!(
            client
                .trace_store
                .lock()
                .unwrap()
                .history(
                    "instance:1",
                    crate::agent_trace_store::AgentHostTraceHistoryQuery {
                        max_events: 20,
                        ..Default::default()
                    },
                    now_ms()
                )
                .events
                .len(),
            1
        );

        let mut terminal = AgentInstanceClientMessage::AgentLifecycle {
            request_id: None,
            channel_id: Some("channel:1".into()),
            agent_id: Some("agent:1".into()),
            instance_id: Some("instance:1".into()),
            agent_name: Some("builder".into()),
            layer: "process".into(),
            status: "exited".into(),
            reason: None,
            detail: None,
            snapshot: None,
            resets_at: None,
            ts: None,
        };
        client.prepare_outbound_message(&mut terminal);
        let history = client.trace_store.lock().unwrap().history(
            "instance:1",
            crate::agent_trace_store::AgentHostTraceHistoryQuery {
                max_events: 20,
                ..Default::default()
            },
            now_ms(),
        );
        assert_eq!(
            history.availability,
            crate::agent_trace_store::AgentHostTraceAvailability::Available
        );
        assert_eq!(history.events.len(), 1);
    }

    #[test]
    fn instance_resume_key_includes_channel_workspace_and_machine_scope() {
        let metadata = serde_json::json!({
            "autoJoinChannelId": "channel-1",
            "workspaceCwd": "/work/project",
            "machineId": "machine-1",
        });

        let left = instance_resume_key_with_headless(
            "wss://relay.example/ws",
            Some("agent-1"),
            "codex",
            "codex",
            Some(&metadata),
            false,
        );
        let right = instance_resume_key_with_headless(
            "wss://relay.example/ws",
            Some("agent-1"),
            "codex",
            "codex",
            Some(&serde_json::json!({
                "autoJoinChannelId": "channel-2",
                "workspaceCwd": "/work/project",
                "machineId": "machine-1",
            })),
            false,
        );

        for observation in ["old", "renamed"] {
            let mut renamed = metadata.clone();
            renamed["hostname"] = serde_json::json!(observation);
            assert_eq!(
                left,
                instance_resume_key_with_headless(
                    "wss://relay.example/ws",
                    Some("agent-1"),
                    "codex",
                    "codex",
                    Some(&renamed),
                    false
                )
            );
        }
        assert!(
            instance_resume_key_with_headless(
                "wss://relay.example/ws",
                Some("agent-1"),
                "codex",
                "codex",
                Some(&serde_json::json!({"hostname":"host", "hostId":"host"})),
                false
            )
            .is_none()
        );
        assert_ne!(left, right);
        assert!(
            instance_resume_key_with_headless(
                "wss://relay.example/ws",
                Some("agent-1"),
                "codex",
                "codex",
                Some(&metadata),
                true
            )
            .is_none()
        );
    }

    #[test]
    fn metadata_previous_instance_id_value_preserves_existing_object_fields() {
        let metadata = metadata_with_previous_instance_id_value(
            Some(serde_json::json!({ "workspaceCwd": "/work/project" })),
            "instance-1",
        )
        .expect("metadata");

        assert_eq!(metadata["workspaceCwd"], "/work/project");
        assert_eq!(metadata["previousInstanceId"], "instance-1");
    }

    #[test]
    fn verified_local_history_is_emitted_without_a_websocket_request() {
        let mut client = super::AgentInstanceConnectionClient::new(
            "wss://relay.example/ws/agent-instances".into(),
            "token".into(),
            "agent".into(),
            "codex".into(),
            None,
        );
        let mut events = client.event_rx.take().expect("event receiver");
        let sender = crate::channel_fixtures::sender(
            Some("user:1"),
            "user",
            "Human",
            "user:1",
            "human@example.test",
        );
        let item = |sequence| {
            crate::channel_fixtures::message(
                &format!("message:{sequence}"),
                "channel:1",
                Some(sequence),
                sender.clone(),
                &format!("body {sequence}"),
                "2026-07-17T00:00:00.000Z",
            )
        };

        client
            .publish_local_history_replay("channel:1", vec![item(4), item(5)])
            .expect("local replay");
        for expected in [4, 5] {
            match events.try_recv().expect("replay event") {
                AgentInstanceConnectionEvent::Server(
                    AgentInstanceServerMessage::ChannelHistoryReplay { message, .. },
                ) => assert_eq!(message.sequence, Some(expected)),
                other => panic!("unexpected event: {other:?}"),
            }
        }
        assert!(client.write_tx_clone().is_none());
        assert!(
            client
                .publish_local_history_replay("channel:1", vec![item(5), item(4)])
                .is_err()
        );
    }
}

fn agent_operation_error(
    message: String,
    failure: Option<crate::protocol::AgentOperationFailure>,
) -> CliError {
    if let Some(failure) = failure {
        return crate::error::AgentOperationError { message, failure }.into();
    }
    if durable_object_runtime_reset(&message) {
        CliError::RelayTransient(message)
    } else {
        CliError::Relay(message)
    }
}

#[cfg(test)]
mod operation_failure_tests {
    use super::*;
    #[tokio::test]
    async fn a_missing_registration_confirmation_produces_typed_deadline_evidence() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            let request = socket.next().await.unwrap().unwrap().into_text().unwrap();
            let body: serde_json::Value = serde_json::from_str(&request).unwrap();
            assert_eq!(body["type"], "agent_instance_connect");
            let _ = stopped.await;
        });
        let mut client = AgentInstanceConnectionClient::new(
            format!("ws://{address}/ws/agent-instances"),
            "fixture-token".into(),
            "builder".into(),
            "codex".into(),
            None,
        );
        let error = client.register().await.unwrap_err();
        let failure = error
            .operation_failure()
            .unwrap_or_else(|| panic!("expected typed deadline evidence, got {error}"));
        assert_eq!(failure.code, "relay.registration_timeout");
        assert_eq!(failure.stage, "relay.await_confirmation");
        assert!(failure.is_valid_observation());
        assert!(error.is_relay_transient());
        assert!(!error.to_string().contains("fixture-token"));
        let _ = stop.send(());
        server.await.unwrap();
    }

    #[test]
    fn safe_failure_classification_and_correlation_survive_the_client() {
        let failure = crate::protocol::AgentOperationFailure {
            code: "postgres_runtime_unavailable".into(),
            diagnostic_id: "diag_11111111-1111-4111-8111-111111111111".into(),
            stage: "relay.authenticate".into(),
            origin_stage: Some("authority.request".into()),
            retryable: true,
        };
        let error = agent_operation_error("Registration failed".into(), Some(failure));
        assert!(error.is_relay_transient());
        assert!(error.to_string().contains("postgres_runtime_unavailable"));
        assert!(error.to_string().contains("stage=relay.authenticate"));
        assert!(error.to_string().contains("origin=authority.request"));
        assert!(
            error
                .to_string()
                .contains("diag_11111111-1111-4111-8111-111111111111")
        );
        assert!(matches!(
            agent_operation_error("Denied".into(), None),
            CliError::Relay(_)
        ));
    }
}
