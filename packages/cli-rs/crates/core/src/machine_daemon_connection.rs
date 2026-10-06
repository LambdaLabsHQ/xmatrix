use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot, watch};
use tokio_tungstenite::tungstenite::Message;

use crate::connection_error::durable_object_runtime_reset;
use crate::error::{CliError, Result};
use crate::http::{self, CLIENT_COMPATIBILITY_PROTOCOL_VERSION, ClientComponent};
use crate::protocol::{
    AgentGoalStatus, ChannelAttachment, DaemonSpawnWorkspace, HubRoutes, with_route,
};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const INITIAL_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);
const INITIAL_READY_TIMEOUT: Duration = Duration::from_secs(60);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(2);
/// Silence that makes the cheap protocol ping inconclusive, so liveness has to
/// be settled by a reply this repository actually guarantees.
const HEARTBEAT_PROBE_AFTER: Duration = Duration::from_secs(4);
/// Silence budget for the definitive probe. Past this the socket is dead.
const HEARTBEAT_PROBE_TIMEOUT: Duration = Duration::from_secs(4);
const COMMAND_LEASE_RENEW_SOCKET_TIMEOUT: Duration = Duration::from_secs(10);
/// Hub leases a pushed command for ten seconds when this daemon advertises
/// `machine_command_admission_ack_v1`. Socket admission and its HTTP fallback
/// both have to land inside that lease, so the socket may only take a third of
/// it: waiting the full lease made every fallback arrive stale and dropped the
/// stop or kill-all it carried.
const COMMAND_ADMISSION_SOCKET_TIMEOUT: Duration = Duration::from_secs(3);
const RECONNECT_BASE: Duration = Duration::from_secs(1);
const RECONNECT_MAX: Duration = Duration::from_secs(30);
/// Bound for a single socket write. A hung send used to stall the same select
/// that runs heartbeats, so a half-open Hub link could sit silent for minutes.
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);
const WRITE_QUEUE_CAPACITY: usize = 64;

type MachineDaemonWsWrite =
    futures_util::stream::SplitSink<crate::websocket::ClientWebSocket, Message>;

fn machine_report_at_rfc3339() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

fn machine_daemon_heartbeat_frame() -> Message {
    // Cloudflare handles protocol ping/pong below the Durable Object and does
    // not wake a hibernated Relay Runtime for this liveness traffic.
    Message::Ping(Default::default())
}

/// Application-level liveness probe, sent only once the cheap protocol ping has
/// left this connection silent past [`HEARTBEAT_PROBE_AFTER`].
///
/// Whether Cloudflare surfaces a protocol pong back to this client is not
/// established anywhere in this repository, so protocol-ping silence alone
/// cannot separate a dead socket from a healthy idle one. The Hub answers every
/// `ping` with `pong` (see `machine-daemon-port.ts`), which makes silence after
/// this frame real evidence. It does wake a hibernated Relay Runtime, so it
/// stays off the steady-state path and only runs when liveness is already in
/// doubt.
fn machine_daemon_liveness_probe_frame() -> Message {
    Message::Text(
        serde_json::json!({
            "type": "ping",
            "requestId": uuid::Uuid::new_v4().to_string(),
        })
        .to_string()
        .into(),
    )
}

/// Write-queue slots kept free for the heartbeat, so a burst of instructions
/// cannot starve the liveness frame that keeps the connection honest.
const HEARTBEAT_WRITE_RESERVE: usize = 1;

/// Whether the connection may take its next instruction. Every instruction
/// writes at most one frame, so while this holds its write cannot find the
/// queue full. When it does not, instructions wait in their own queue until
/// the writer drains: a backlog built up while offline is backpressure, not a
/// reason to drop the connection and rebuild the same backlog (#3208).
fn machine_daemon_accepts_instruction(out_tx: &mpsc::Sender<Message>) -> bool {
    out_tx.capacity() > HEARTBEAT_WRITE_RESERVE
}

/// Queue a heartbeat unless the queue is full. A full queue means frames are
/// already on their way; a writer that is actually stuck is ended by
/// `WRITE_TIMEOUT`, not here. Returns whether the frame was queued.
fn enqueue_machine_daemon_heartbeat(
    out_tx: &mpsc::Sender<Message>,
    frame: Message,
) -> std::result::Result<bool, String> {
    match out_tx.try_send(frame) {
        Ok(()) => Ok(true),
        Err(mpsc::error::TrySendError::Full(_)) => Ok(false),
        Err(mpsc::error::TrySendError::Closed(_)) => Err("Machine Daemon writer closed".into()),
    }
}

fn enqueue_machine_daemon_write(
    out_tx: &mpsc::Sender<Message>,
    frame: Message,
) -> std::result::Result<(), String> {
    out_tx.try_send(frame).map_err(|error| match error {
        mpsc::error::TrySendError::Full(_) => "Machine Daemon write queue is backed up".to_string(),
        mpsc::error::TrySendError::Closed(_) => "Machine Daemon writer closed".to_string(),
    })
}

fn enqueue_machine_daemon_request<T>(
    out_tx: &mpsc::Sender<Message>,
    request_id: String,
    message: serde_json::Value,
    reply: oneshot::Sender<std::result::Result<T, String>>,
    pending: &mut HashMap<String, oneshot::Sender<std::result::Result<T, String>>>,
) -> std::result::Result<(), String> {
    if let Err(error) =
        enqueue_machine_daemon_write(out_tx, Message::Text(message.to_string().into()))
    {
        let _ = reply.send(Err(error.clone()));
        return Err(error);
    }
    pending.insert(request_id, reply);
    Ok(())
}

fn enqueue_replied_write<T>(
    out_tx: &mpsc::Sender<Message>,
    text: String,
    reply: oneshot::Sender<std::result::Result<T, String>>,
) -> std::result::Result<oneshot::Sender<std::result::Result<T, String>>, String> {
    if let Err(error) = enqueue_machine_daemon_write(out_tx, Message::Text(text.into())) {
        let _ = reply.send(Err(error.clone()));
        return Err(error);
    }
    Ok(reply)
}

async fn run_machine_daemon_writer(
    mut write: MachineDaemonWsWrite,
    mut out_rx: mpsc::Receiver<Message>,
) -> std::result::Result<(), String> {
    while let Some(frame) = out_rx.recv().await {
        match tokio::time::timeout(WRITE_TIMEOUT, write.send(frame)).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => return Err(format!("Machine Daemon write failed: {error}")),
            Err(_) => {
                return Err(format!(
                    "Machine Daemon write timed out after {}s",
                    WRITE_TIMEOUT.as_secs()
                ));
            }
        }
    }
    let _ = tokio::time::timeout(WRITE_TIMEOUT, write.close()).await;
    Ok(())
}

async fn abort_machine_daemon_writer(writer: tokio::task::JoinHandle<()>) {
    writer.abort();
    let _ = writer.await;
}

pub fn derive_connection_url(hub_url: &str) -> String {
    crate::websocket::domain_connection_url(hub_url, "/ws/machine-daemons")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerializedMachineDaemon {
    pub id: String,
    pub user_id: String,
    pub name: String,
    pub email: String,
    pub metadata: serde_json::Value,
    pub connected_at: String,
    pub last_seen_at: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub paused: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub paused_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub paused_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub machine_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub hostname: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub daemon_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub cli_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub app_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineSpawnContext {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub requested_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub requested_effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub requested_parameters: Option<std::collections::BTreeMap<String, String>>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        default,
        deserialize_with = "crate::protocol::deserialize_optional_message_source"
    )]
    pub initial_message_source: Option<crate::protocol::AgentRuntimeMessageSource>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub goal: Option<AgentGoalStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MachineStartupStep {
    pub phase: String,
    pub at_millis: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MachineConnectionRetry {
    pub attempt: u32,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub next_attempt_at_millis: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MachineRunSnapshotItem {
    #[serde(
        skip_serializing_if = "Option::is_none",
        default,
        deserialize_with = "crate::protocol::deserialize_optional_execution_snapshot"
    )]
    pub task_execution: Option<crate::protocol::AgentRuntimeExecutionSnapshot>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        default,
        deserialize_with = "crate::protocol::deserialize_optional_operation_failure"
    )]
    pub operation_failure: Option<crate::protocol::AgentOperationFailure>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub wrapper_version: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub startup_steps: Vec<MachineStartupStep>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub connection_retry: Option<MachineConnectionRetry>,
    /// Safe presentation evidence; never a grant or Run lifecycle command.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub status_phase: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub wrapper_ready_at_millis: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub execution_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub agent_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub pid: Option<u32>,
}

/// Exact Authority lease evidence. Hosts may echo it on the matching completion and,
/// for spawn commands, lease renewal so Runtime can recover across hibernation
/// without weakening the lease fence.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineDaemonCommandLease {
    pub lease_owner: String,
    pub lease_generation: u64,
    pub entity_version: u64,
    pub daemon_epoch: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MachineWorktreeDisposition {
    #[serde(rename = "retain")]
    Retain,
    #[serde(rename = "abandon")]
    Abandon,
}

/// A cross-machine handoff asks the stopping Run's daemon to carry its work:
/// everything in its checkout, committed or not, is pushed to `branch` on the
/// repository's remote so a successor elsewhere can continue from it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineHandoffExport {
    pub branch: String,
    /// The Channel whose Space's GitHub connection authorizes the push.
    pub channel_id: String,
}

/// What became of a [`MachineHandoffExport`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineHandoffExportResult {
    pub branch: String,
    /// `pushed` or `failed`.
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub commit: Option<String>,
    /// The commit the checkout was on before its uncommitted work was added.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub base: Option<String>,
    /// Whether uncommitted changes were captured in `commit`.
    #[serde(default)]
    pub dirty: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub error: Option<String>,
}

impl MachineWorktreeDisposition {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Retain => "retain",
            Self::Abandon => "abandon",
        }
    }
}

/// The launch-relevant slice of a harness preset, as the Hub sends it on
/// every spawn (`agentHarnessSpec` in `@xmatrix/protocol`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHarnessSpec {
    pub id: String,
    pub runtime: String,
    pub agent_type: String,
    pub backend: String,
    #[serde(default)]
    pub default_args: Vec<String>,
    #[serde(default)]
    pub acp_args: Option<Vec<String>>,
    #[serde(default)]
    pub launcher_names: Vec<String>,
    #[serde(default)]
    pub classic_config_dirs: Vec<String>,
    #[serde(default)]
    pub install_hint: Option<String>,
}

/// Hub control intents understood by a Machine Daemon.
///
/// This protocol contains no Human presence or Agent Instance channel
/// lifecycle messages. A Machine Daemon owns only machine-local control-plane
/// work: spawn, stop, privileged-request resolution, and worktree cleanup.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum MachineDaemonCommand {
    MachineSpawnAgent {
        request_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        registration: Option<crate::agent_registration::RegistrationLaunchBinding>,
        space_id: String,
        #[serde(default)]
        run_id: Option<String>,
        #[serde(default)]
        instance_id: Option<String>,
        #[serde(default)]
        launcher_id: Option<String>,
        #[serde(default)]
        materializer_id: Option<String>,
        #[serde(default)]
        execution_key: Option<String>,
        #[serde(default)]
        launch_id: Option<String>,
        workspace: DaemonSpawnWorkspace,
        #[serde(default)]
        management_space_id: Option<String>,
        channel_id: String,
        runtime: String,
        #[serde(default)]
        runtime_args: Option<Vec<String>>,
        #[serde(default)]
        agent_backend: Option<String>,
        #[serde(default)]
        agent_preset_id: Option<String>,
        /// The Hub's harness preset. The Hub is the only preset authority.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        harness: Option<AgentHarnessSpec>,
        #[serde(default)]
        agent_acp_args: Option<Vec<String>>,
        agent_name: String,
        #[serde(default)]
        identity_id: Option<String>,
        /// The registration's own instructions, delivered as the trusted
        /// initial prompt. The wire name predates the retired Role feature and
        /// is kept so older Hubs and daemons still agree on it. The retired
        /// `roleReminder`, `roleSkills`, `roleAppRequirements`, and
        /// `agentAvatarUrl` (the Role avatar) are not declared; this enum does
        /// not deny unknown fields, so an older Hub that still sends them is
        /// ignored rather than rejected.
        #[serde(default)]
        role_initial_prompt: Option<String>,
        #[serde(default)]
        resume: Option<bool>,
        #[serde(default)]
        resume_instance_id: Option<String>,
        #[serde(default)]
        resume_session_key: Option<String>,
        #[serde(default)]
        repo_identity: Option<String>,
        #[serde(default)]
        repo_key_id: Option<String>,
        #[serde(default)]
        slot_id: Option<String>,
        #[serde(default)]
        resume_worktree_bootstrap: Option<bool>,
        #[serde(default)]
        handoff_transfer: Option<bool>,
        #[serde(default)]
        handoff_source_instance_id: Option<String>,
        #[serde(default)]
        handoff_source_resume_session_key: Option<String>,
        #[serde(default)]
        context: Option<MachineSpawnContext>,
        #[serde(default)]
        goal: Option<AgentGoalStatus>,
        #[serde(default)]
        run_worktree: Option<bool>,
        #[serde(default)]
        remote_repo: Option<String>,
        /// Channel message that summoned this run. The prompt carries its text,
        /// so live delivery never acknowledges it; the wrapper acks this id once
        /// instead of replaying the message on every reconnect catch-up.
        #[serde(default)]
        source_message_id: Option<String>,
        prompt: String,
        #[serde(default)]
        attachments: Option<Vec<ChannelAttachment>>,
        #[serde(default)]
        relay_lease: Option<MachineDaemonCommandLease>,
    },
    MachineStopAgent {
        request_id: String,
        #[serde(default)]
        run_id: Option<String>,
        #[serde(default)]
        execution_key: Option<String>,
        #[serde(default)]
        agent_id: Option<String>,
        #[serde(default)]
        instance_id: Option<String>,
        #[serde(default)]
        resume_session_key: Option<String>,
        #[serde(default)]
        repo_identity: Option<String>,
        #[serde(default)]
        repo_key_id: Option<String>,
        #[serde(default)]
        slot_id: Option<String>,
        #[serde(default)]
        pid: Option<u32>,
        #[serde(default)]
        reason: Option<String>,
        #[serde(default)]
        preserve_instance_for_reborn: Option<bool>,
        #[serde(default)]
        worktree_disposition: Option<MachineWorktreeDisposition>,
        #[serde(default)]
        handoff_export: Option<MachineHandoffExport>,
        #[serde(default)]
        relay_lease: Option<MachineDaemonCommandLease>,
    },
    MachineRequestResolve {
        #[serde(default)]
        request_id: Option<String>,
        daemon_request_id: String,
        decision: String,
        #[serde(default)]
        remember: Option<serde_json::Value>,
        #[serde(default)]
        secret_grant_id: Option<String>,
        resolved_by: String,
        #[serde(default)]
        resolved_by_label: Option<String>,
        #[serde(default)]
        relay_lease: Option<MachineDaemonCommandLease>,
    },
    MachineWorktreeCleanup {
        request_id: String,
        workspace: crate::protocol::WorkspaceRef,
        channel_id: String,
        scope_channel_id: String,
        worktree_path: String,
        #[serde(default)]
        branch: Option<String>,
        #[serde(default)]
        base_ref: Option<String>,
        reason: String,
        #[serde(default)]
        relay_lease: Option<MachineDaemonCommandLease>,
    },
    MachineRecoverReply {
        request_id: String,
        run_id: String,
        instance_id: String,
        execution_key: String,
        channel_id: String,
        execution_id: String,
        #[serde(default)]
        message_id: Option<String>,
        #[serde(default)]
        relay_lease: Option<MachineDaemonCommandLease>,
    },
    MachineQuotaProbe {
        request_id: String,
        probe: MachineQuotaProbeRequest,
        #[serde(default)]
        relay_lease: Option<MachineDaemonCommandLease>,
    },
    /// Owner-approved work on one harness. It names only a preset and an
    /// action; the daemon runs the recipe compiled into it, never argv from Hub.
    MachineHarnessAction {
        request_id: String,
        preset_id: String,
        action: HarnessAction,
        #[serde(default)]
        relay_lease: Option<MachineDaemonCommandLease>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HarnessAction {
    Install,
    Update,
    Uninstall,
    AutoUpdateOn,
    AutoUpdateOff,
    Refresh,
    /// The preset's registry published a version this daemon has not seen.
    Release,
}

include!("../../../shared/harness_action_names.rs");

impl HarnessAction {
    harness_action_names!();

    pub fn parse(value: &str) -> Option<Self> {
        serde_json::from_value(serde_json::Value::String(value.to_string())).ok()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HarnessActionStatus {
    Succeeded,
    Failed,
    Unsupported,
}

/// `item` and `inventory` are bounded harness inventory observations.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessActionResult {
    pub preset_id: String,
    pub action: HarnessAction,
    pub status: HarnessActionStatus,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub exit_code: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub output_tail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub item: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub inventory: Option<serde_json::Value>,
}

/// A bounded, read-only request for the quota facts of idle local Profiles.
///
/// The daemon resolves each target strictly by local Profile id, reads the
/// provider quota that a spawn of that Profile would use, and echoes the
/// target's `configuration_digest` unchanged. It never starts a Run.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineQuotaProbeRequest {
    pub request_id: String,
    pub connection_epoch: u64,
    pub targets: Vec<MachineQuotaProbeTarget>,
    /// The Hub accepts a `label` on each window only when it sets this.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub window_labels: bool,
    /// The Hub accepts a result's `quotaAccount` only when it sets this.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub quota_account: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineQuotaProbeTarget {
    /// The harness to read, as `registration:<harness>`.
    pub target_id: String,
    pub configuration_digest: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineQuotaProbeResultProbe {
    pub request_id: String,
    pub connection_epoch: u64,
    pub results: Vec<MachineQuotaProbeTargetResult>,
}

/// One target's outcome. `status` is `observed` or `unavailable`; an
/// `unavailable` result carries a `reason` and never fabricated numbers.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineQuotaProbeTargetResult {
    pub target_id: String,
    pub configuration_digest: String,
    pub status: String,
    /// The quota authority that produced the windows, e.g. `provider_api`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub quota_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub quota_observed_at: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub quota_usages: Vec<MachineQuotaProbeWindow>,
    /// Whether the provider still serves the account, sent only when the
    /// probe asked for it.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub quota_account: Option<crate::protocol::LlmQuotaAccount>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineQuotaProbeWindow {
    pub percent: f64,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub reset_at: Option<String>,
    /// The provider's name for the window (`5h`, `1w`), sent only when the
    /// probe asked for window labels.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub label: Option<String>,
}

/// Machine-local results and snapshots reported to the Hub.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum MachineDaemonReport {
    MachineCommandAdmitted {
        request_id: String,
        control_id: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        launch_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        channel_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        admitted_at: Option<String>,
        relay_lease: MachineDaemonCommandLease,
    },
    MachineQuotaProbeResult {
        request_id: String,
        probe: MachineQuotaProbeResultProbe,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        relay_lease: Option<MachineDaemonCommandLease>,
    },
    MachineHarnessActionResult {
        request_id: String,
        result: HarnessActionResult,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        relay_lease: Option<MachineDaemonCommandLease>,
    },
    MachineStopResult {
        request_id: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        run_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        execution_key: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        agent_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        instance_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        resume_session_key: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        repo_identity: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        repo_key_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        slot_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        worktree_disposition: Option<MachineWorktreeDisposition>,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        pid: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        cleanup_reason: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        error: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        handoff_export: Option<MachineHandoffExportResult>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        relay_lease: Option<MachineDaemonCommandLease>,
    },
    MachineRequestResolve {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        request_id: Option<String>,
        daemon_request_id: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        machine_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        host_id: Option<String>,
        decision: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        remember: Option<serde_json::Value>,
    },
    MachineRequestResolveResult {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        request_id: Option<String>,
        daemon_request_id: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        machine_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        host_id: Option<String>,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        status: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        error: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        relay_lease: Option<MachineDaemonCommandLease>,
    },
    MachineRequestNotice {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        request_id: Option<String>,
        channel_id: String,
        body: String,
        metadata: serde_json::Value,
    },
    MachineRunExited {
        #[serde(
            skip_serializing_if = "Option::is_none",
            default,
            deserialize_with = "crate::protocol::deserialize_optional_execution_snapshot"
        )]
        task_execution: Option<crate::protocol::AgentRuntimeExecutionSnapshot>,
        #[serde(
            skip_serializing_if = "Option::is_none",
            default,
            deserialize_with = "crate::protocol::deserialize_optional_operation_failure"
        )]
        operation_failure: Option<crate::protocol::AgentOperationFailure>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        wrapper_version: Option<String>,
        #[serde(skip_serializing_if = "Vec::is_empty", default)]
        startup_steps: Vec<MachineStartupStep>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        connection_retry: Option<MachineConnectionRetry>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        wrapper_ready_at_millis: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        request_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        run_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        execution_key: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        agent_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        agent_name: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        pid: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        status: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        exit_code: Option<i32>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        status_phase: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        run_status_detail: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        completed: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        delivered: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        stdout_log_path: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        stderr_log_path: Option<String>,
        /// `sleeping` when the daemon ended this idle Run so its Instance rests
        /// until the next Channel message (docs/instance-sleep.md §2).
        #[serde(skip_serializing_if = "Option::is_none", default)]
        rest_reason: Option<String>,
    },
    MachineRunSnapshot {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        request_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        snapshot_complete: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        registry_connection_epoch: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        registry_sequence: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        captured_at: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        machine_resources: Option<serde_json::Value>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        harness_inventory: Option<serde_json::Value>,
        runs: Vec<MachineRunSnapshotItem>,
    },
    MachineSpawnResult {
        request_id: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        launch_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        run_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        execution_key: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        instance_id: Option<String>,
        machine_id: String,
        canonical_cwd: String,
        channel_id: String,
        agent_name: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        identity_id: Option<String>,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        spawned_at: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        registry_connection_epoch: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        registry_sequence: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        pid: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        error: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        metadata: Option<serde_json::Value>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        relay_lease: Option<MachineDaemonCommandLease>,
    },
    MachineSpawnAuthRequired {
        request_id: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        run_id: Option<String>,
        channel_id: String,
        agent_name: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        identity_id: Option<String>,
        verification_uri_complete: String,
        user_code: String,
        expires_in: u64,
    },
    MachineWorktreeCleanupResult {
        request_id: String,
        workspace: crate::protocol::WorkspaceRef,
        channel_id: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        scope_channel_id: Option<String>,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        removed: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        needs_cleanup: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        error: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        relay_lease: Option<MachineDaemonCommandLease>,
    },
    MachineRecoverReplyResult {
        request_id: String,
        run_id: String,
        instance_id: String,
        execution_key: String,
        channel_id: String,
        execution_id: String,
        ok: bool,
        result: serde_json::Value,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        relay_lease: Option<MachineDaemonCommandLease>,
    },
}

impl MachineDaemonCommand {
    pub fn relay_lease(&self) -> Option<&MachineDaemonCommandLease> {
        match self {
            Self::MachineSpawnAgent { relay_lease, .. }
            | Self::MachineStopAgent { relay_lease, .. }
            | Self::MachineRequestResolve { relay_lease, .. }
            | Self::MachineRecoverReply { relay_lease, .. }
            | Self::MachineWorktreeCleanup { relay_lease, .. }
            | Self::MachineQuotaProbe { relay_lease, .. }
            | Self::MachineHarnessAction { relay_lease, .. } => relay_lease.as_ref(),
        }
    }
}

#[derive(Debug, Clone)]
pub enum MachineDaemonConnectionEvent {
    Command(MachineDaemonCommand),
    ActivationReceipt(MachineDaemonActivationReceipt),
    CommandCompletionAcked {
        control_id: String,
    },
    Reconnected {
        daemon: SerializedMachineDaemon,
    },
    Disconnected {
        reason: String,
    },
    /// `correlation` names the rejected frame and Hub's diagnostic id, when
    /// Hub sent them, so a log line can be matched to its request.
    Error {
        message: String,
        correlation: Option<String>,
    },
    /// Hub's verdict on one approval-card report. `request_id` is the report
    /// identity (`machine-request-notice:<daemon request id>:<phase>`); the
    /// result is the persisted card message id or the rejection message.
    RequestNoticeDelivery {
        request_id: String,
        result: std::result::Result<String, String>,
    },
    ShutdownRequested {
        reason: Option<String>,
    },
}

/// Report identities the daemon request broker gives its approval cards.
pub const MACHINE_REQUEST_NOTICE_REPORT_PREFIX: &str = "machine-request-notice:";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MachineDaemonActivationConnect {
    pub mode: String,
    pub transaction_id: String,
    pub transaction_nonce: String,
    pub artifact_sha256: String,
    pub source_connection_epoch: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MachineDaemonActivationReceipt {
    #[serde(rename = "type")]
    pub message_type: String,
    pub request_id: String,
    pub transaction_id: String,
    pub artifact_sha256: String,
    pub connection_epoch: u64,
    pub phase: String,
    pub receipt_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_set_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_run_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prepared_receipt_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_fenced_receipt_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_receipt_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MachineDaemonAdoptedRunEvidence {
    pub run_id: String,
    pub adoption_key_hash: String,
    pub wrapper_nonce: String,
    pub process_birth_id: String,
    pub executable_sha256: String,
}

#[derive(Clone)]
struct MachineDaemonIdentity {
    display_name: String,
    machine_id: String,
    hostname: String,
    metadata: Arc<RwLock<Option<serde_json::Value>>>,
    capabilities: Vec<String>,
    activation: Arc<RwLock<Option<MachineDaemonActivationConnect>>>,
}

enum ConnectionInstruction {
    Report(MachineDaemonReport),
    ConfirmRunReport {
        report: MachineDaemonReport,
        request_id: String,
        run_id: String,
        reply: oneshot::Sender<std::result::Result<(), String>>,
    },
    AdmitCommand {
        request_id: String,
        report: MachineDaemonReport,
        reply: oneshot::Sender<std::result::Result<String, String>>,
    },
    RefreshAuthCredential(String),
    /// The owner removed this Machine; Hub refused its credential refresh.
    Retired(String),
    RenewLease {
        request_id: String,
        control_id: String,
        relay_lease: MachineDaemonCommandLease,
        reply: oneshot::Sender<std::result::Result<String, String>>,
    },
    PrepareActivation {
        request_id: String,
        transaction_id: String,
        artifact_sha256: String,
        connection_epoch: u64,
        run_set_digest: String,
        expected_run_ids: Vec<String>,
        adopted_run_ids: Vec<String>,
        natural_terminal_run_ids: Vec<String>,
        adopted_runs: Vec<MachineDaemonAdoptedRunEvidence>,
        reply: oneshot::Sender<std::result::Result<MachineDaemonActivationReceipt, String>>,
    },
    BeginActivation {
        request_id: String,
        transaction_id: String,
        transaction_nonce: String,
        artifact_sha256: String,
        connection_epoch: u64,
        reply: oneshot::Sender<std::result::Result<MachineDaemonActivationReceipt, String>>,
    },
    AdvanceActivation {
        request_id: String,
        transaction_id: String,
        artifact_sha256: String,
        connection_epoch: u64,
        phase: String,
        reply: oneshot::Sender<std::result::Result<MachineDaemonActivationReceipt, String>>,
    },
    Close,
}

/// Independent, actor-owned Machine Daemon control connection.
///
/// All socket writes are serialized by one task. Callers compose with the
/// connection through an MPSC queue and an atomic health bit; no shared socket
/// mutex or Agent Instance connection object is exposed.
pub struct MachineDaemonConnectionClient {
    instruction_tx: mpsc::UnboundedSender<ConnectionInstruction>,
    connected: Arc<AtomicBool>,
    connection_epoch: Arc<AtomicU64>,
    registry_sequence: Arc<AtomicU64>,
    pub event_rx: Option<mpsc::UnboundedReceiver<MachineDaemonConnectionEvent>>,
    task: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    connection_url: String,
    enrollment_token: Arc<RwLock<String>>,
    machine_credential_rx: watch::Receiver<Option<String>>,
    activation_receipt: Arc<RwLock<Option<MachineDaemonActivationReceipt>>>,
    identity: MachineDaemonIdentity,
}

fn mark_machine_daemon_transport_offline(connected: &AtomicBool) {
    // Keep the last authenticated epoch while reconnecting. HTTP command pull
    // is allowed to use it until Hub accepts a newer connection epoch, which
    // atomically replaces the retained value. Explicit shutdown and protocol
    // upgrade rejection still clear the epoch at their call sites.
    connected.store(false, Ordering::Release);
}

impl MachineDaemonConnectionClient {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        connection_url: String,
        token: String,
        display_name: String,
        machine_id: String,
        hostname: String,
        metadata: Option<serde_json::Value>,
        capabilities: Vec<String>,
    ) -> Self {
        let (instruction_tx, _) = mpsc::unbounded_channel();
        let (_, machine_credential_rx) = watch::channel(None);
        Self {
            instruction_tx,
            connected: Arc::new(AtomicBool::new(false)),
            connection_epoch: Arc::new(AtomicU64::new(0)),
            registry_sequence: Arc::new(AtomicU64::new(0)),
            event_rx: None,
            task: Arc::new(Mutex::new(None)),
            connection_url,
            enrollment_token: Arc::new(RwLock::new(token)),
            machine_credential_rx,
            activation_receipt: Arc::new(RwLock::new(None)),
            identity: MachineDaemonIdentity {
                display_name,
                machine_id,
                hostname,
                metadata: Arc::new(RwLock::new(metadata)),
                capabilities: capabilities
                    .into_iter()
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
                    .collect(),
                activation: Arc::new(RwLock::new(None)),
            },
        }
    }

    pub fn set_activation(&mut self, activation: MachineDaemonActivationConnect) {
        if let Ok(mut slot) = self.identity.activation.write() {
            *slot = Some(activation);
        }
    }

    pub async fn register(&mut self) -> Result<SerializedMachineDaemon> {
        self.disconnect();
        if let Ok(mut receipt) = self.activation_receipt.write() {
            *receipt = None;
        }
        let (instruction_tx, instruction_rx) = mpsc::unbounded_channel();
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let (machine_credential_tx, machine_credential_rx) = watch::channel(None);
        let (ready_tx, ready_rx) = oneshot::channel();
        let connected = Arc::new(AtomicBool::new(false));
        let connection_epoch = Arc::new(AtomicU64::new(0));
        let task = tokio::spawn(run_machine_daemon_connection(
            self.connection_url.clone(),
            self.enrollment_token.clone(),
            self.identity.clone(),
            instruction_rx,
            event_tx,
            ready_tx,
            connected.clone(),
            connection_epoch.clone(),
            machine_credential_tx,
            self.activation_receipt.clone(),
        ));

        match tokio::time::timeout(INITIAL_READY_TIMEOUT, ready_rx).await {
            Ok(Ok(Ok(daemon))) => {
                self.instruction_tx = instruction_tx;
                self.connected = connected;
                self.connection_epoch = connection_epoch;
                self.event_rx = Some(event_rx);
                self.machine_credential_rx = machine_credential_rx;
                if let Ok(mut slot) = self.task.lock() {
                    *slot = Some(task);
                }
                Ok(daemon)
            }
            Ok(Ok(Err(message))) => {
                task.abort();
                Err(CliError::Relay(message))
            }
            Ok(Err(_)) => {
                task.abort();
                Err(CliError::Relay(
                    "Machine Daemon connection stopped before authentication completed".into(),
                ))
            }
            Err(_) => {
                task.abort();
                Err(CliError::RelayTransient(
                    "Timed out waiting for Machine Daemon authentication".into(),
                ))
            }
        }
    }

    pub fn bind_registry_causality(
        &self,
        report: MachineDaemonReport,
    ) -> Result<MachineDaemonReport> {
        if !self.is_connected() {
            return Err(CliError::RelayTransient(
                "Machine Daemon control connection is offline".into(),
            ));
        }
        let epoch = self.connection_epoch().ok_or_else(|| {
            CliError::RelayTransient("Machine Daemon connection epoch is unavailable".into())
        })?;
        Ok(self.bind_registry_causality_at_epoch(report, epoch))
    }

    /// Bind a polled command result to the exact lease epoch that authorized its
    /// physical side effect. The socket may be offline by definition, so this
    /// cannot use `connection_epoch()`. A newer reconnect is allowed to have
    /// advanced the locally known epoch; Hub authority will fence a stale lease,
    /// while the journal retains the causally stamped result for reconciliation.
    pub fn bind_claimed_command_registry_causality(
        &self,
        report: MachineDaemonReport,
    ) -> Result<MachineDaemonReport> {
        let MachineDaemonReport::MachineSpawnResult {
            ok: true,
            relay_lease: Some(relay_lease),
            ..
        } = &report
        else {
            return Ok(report);
        };
        let known_epoch = self.claim_connection_epoch().ok_or_else(|| {
            CliError::RelayTransient("Machine Daemon claim epoch is unavailable".into())
        })?;
        if relay_lease.daemon_epoch > known_epoch {
            return Err(CliError::Relay(
                "Machine Daemon command lease is newer than the authenticated claim epoch".into(),
            ));
        }
        let claim_epoch = relay_lease.daemon_epoch;
        Ok(self.bind_registry_causality_at_epoch(report, claim_epoch))
    }

    fn bind_registry_causality_at_epoch(
        &self,
        mut report: MachineDaemonReport,
        epoch: u64,
    ) -> MachineDaemonReport {
        match &mut report {
            MachineDaemonReport::MachineRunSnapshot {
                registry_connection_epoch,
                registry_sequence,
                captured_at,
                ..
            } => {
                if registry_connection_epoch.is_none()
                    || registry_sequence.is_none()
                    || captured_at.is_none()
                {
                    let sequence = self.registry_sequence.fetch_add(1, Ordering::AcqRel) + 1;
                    *registry_connection_epoch = Some(epoch);
                    *registry_sequence = Some(sequence);
                    *captured_at = Some(machine_report_at_rfc3339());
                }
            }
            MachineDaemonReport::MachineSpawnResult {
                ok: true,
                registry_connection_epoch,
                registry_sequence,
                ..
            } if (registry_connection_epoch.is_none() || registry_sequence.is_none()) => {
                let sequence = self.registry_sequence.fetch_add(1, Ordering::AcqRel) + 1;
                *registry_connection_epoch = Some(epoch);
                *registry_sequence = Some(sequence);
            }
            _ => {}
        }
        report
    }

    pub fn send_report(&self, report: MachineDaemonReport) -> Result<()> {
        let report = self.bind_registry_causality(report)?;
        self.instruction_tx
            .send(ConnectionInstruction::Report(report))
            .map_err(|_| CliError::Relay("Machine Daemon control connection is closed".into()))
    }

    /// Cache the latest observation for reconnect and send an additive partial snapshot.
    pub fn report_harness_inventory(&self, inventory: serde_json::Value) -> Result<()> {
        {
            let mut slot = self
                .identity
                .metadata
                .write()
                .map_err(|_| CliError::Relay("Machine metadata lock is poisoned".into()))?;
            let metadata = slot.get_or_insert_with(|| serde_json::json!({}));
            metadata["harnesses"] = inventory.clone();
        }
        if !self.is_connected() {
            return Ok(());
        }
        self.send_report(MachineDaemonReport::MachineRunSnapshot {
            request_id: None,
            snapshot_complete: Some(false),
            registry_connection_epoch: None,
            registry_sequence: None,
            captured_at: None,
            machine_resources: None,
            harness_inventory: Some(inventory),
            runs: Vec::new(),
        })
    }

    /// Keep terminal recovery records until Hub confirms lifecycle and lease finalization.
    /// Older Hubs omit this additive receipt: timeout must preserve the record.
    pub async fn confirm_run_report(&self, mut report: MachineDaemonReport) -> Result<()> {
        // Legacy observations without a Run id cannot own an AI lease.
        if matches!(
            &report,
            MachineDaemonReport::MachineRunExited { run_id: None, .. }
        ) {
            return self.send_report(report);
        }
        if !self.is_connected() {
            return Err(CliError::RelayTransient(
                "Machine Daemon control connection is offline".into(),
            ));
        }
        let request_id = uuid::Uuid::new_v4().to_string();
        let run_id = match &mut report {
            MachineDaemonReport::MachineRunExited {
                request_id: id,
                run_id: Some(run),
                ..
            } => {
                *id = Some(request_id.clone());
                run.clone()
            }
            _ => {
                return Err(CliError::Relay(
                    "Confirmed terminal report requires a Run id".into(),
                ));
            }
        };
        let (reply, receive) = oneshot::channel();
        self.instruction_tx
            .send(ConnectionInstruction::ConfirmRunReport {
                report,
                request_id,
                run_id,
                reply,
            })
            .map_err(|_| CliError::RelayTransient("Machine Daemon connection is closed".into()))?;
        tokio::time::timeout(Duration::from_secs(30), receive)
            .await
            .map_err(|_| {
                CliError::RelayTransient("Timed out awaiting terminal Run finalization".into())
            })?
            .map_err(|_| {
                CliError::RelayTransient("Disconnected before terminal Run finalization".into())
            })?
            .map_err(CliError::RelayTransient)
    }

    /// Persistently admit a command and wait until Authority has extended its
    /// short pre-admission lease. Callers must not execute the side effect
    /// before this acknowledgement arrives.
    pub async fn admit_command(&self, report: MachineDaemonReport) -> Result<String> {
        if !self.is_connected() {
            return Err(CliError::RelayTransient(
                "Machine Daemon control connection is offline".into(),
            ));
        }
        let request_id = match &report {
            MachineDaemonReport::MachineCommandAdmitted { request_id, .. } => request_id.clone(),
            _ => {
                return Err(CliError::Relay(
                    "Invalid Machine Daemon admission report".into(),
                ));
            }
        };
        let (reply_tx, reply_rx) = oneshot::channel();
        self.instruction_tx
            .send(ConnectionInstruction::AdmitCommand {
                request_id,
                report,
                reply: reply_tx,
            })
            .map_err(|_| CliError::Relay("Machine Daemon control connection is closed".into()))?;
        match tokio::time::timeout(COMMAND_ADMISSION_SOCKET_TIMEOUT, reply_rx).await {
            Ok(Ok(Ok(lease_until))) => Ok(lease_until),
            Ok(Ok(Err(error))) => Err(CliError::RelayTransient(error)),
            Ok(Err(_)) => Err(CliError::RelayTransient(
                "Machine Daemon command admission was cancelled".into(),
            )),
            Err(_) => Err(CliError::RelayTransient(format!(
                "command admission timed out after {}s",
                COMMAND_ADMISSION_SOCKET_TIMEOUT.as_secs(),
            ))),
        }
    }

    /// Prove the exact spawn lease on the live control socket.
    ///
    /// HTTP `/api/daemon/command-lease/renew` is the fallback when this socket
    /// cannot complete the same Authority renew.
    pub async fn renew_command_lease_over_socket(
        &self,
        control_id: &str,
        relay_lease: &MachineDaemonCommandLease,
    ) -> Result<String> {
        if !self.owns_connection_epoch(relay_lease.daemon_epoch) {
            return Err(CliError::Relay(
                "Machine Daemon command lease belongs to a stale connection epoch".into(),
            ));
        }
        if !self.is_connected() {
            return Err(CliError::RelayTransient(
                "Machine Daemon control connection is offline".into(),
            ));
        }
        let request_id = uuid::Uuid::new_v4().to_string();
        let (reply_tx, reply_rx) = oneshot::channel();
        self.instruction_tx
            .send(ConnectionInstruction::RenewLease {
                request_id,
                control_id: control_id.to_string(),
                relay_lease: relay_lease.clone(),
                reply: reply_tx,
            })
            .map_err(|_| {
                CliError::RelayTransient("Machine Daemon control connection is closed".into())
            })?;
        match tokio::time::timeout(COMMAND_LEASE_RENEW_SOCKET_TIMEOUT, reply_rx).await {
            Ok(Ok(Ok(lease_until))) => Ok(lease_until),
            Ok(Ok(Err(error))) => Err(map_socket_lease_renew_error(&error)),
            Ok(Err(_)) => Err(CliError::RelayTransient(
                "Machine Daemon lease renewal was cancelled".into(),
            )),
            Err(_) => Err(CliError::RelayTransient(format!(
                "command lease renewal timed out after {}s",
                COMMAND_LEASE_RENEW_SOCKET_TIMEOUT.as_secs(),
            ))),
        }
    }

    /// Mint the replacement Machine credential outside the socket actor, then
    /// enqueue only the bounded WebSocket write. Credential enrollment is an
    /// HTTP request and may stall on a transient proxy/TLS failure; awaiting it
    /// inside the actor would also stall heartbeats and let Hub presence expire
    /// even though the daemon process and control socket were still alive.
    pub async fn refresh_auth(&self, token: String) -> Result<()> {
        *self
            .enrollment_token
            .write()
            .map_err(|_| CliError::Relay("Machine Daemon auth state poisoned".into()))? =
            token.clone();
        let enrollment = match mint_machine_daemon_credential(
            &self.connection_url,
            &token,
            &self.identity,
        )
        .await
        {
            Ok(enrollment) => enrollment,
            Err(error) => {
                if machine_retired(&error) {
                    let _ = self
                        .instruction_tx
                        .send(ConnectionInstruction::Retired(error.to_string()));
                }
                return Err(error);
            }
        };
        self.instruction_tx
            .send(ConnectionInstruction::RefreshAuthCredential(
                enrollment.credential,
            ))
            .map_err(|_| CliError::Relay("Machine Daemon control connection is closed".into()))
    }

    pub fn is_connected(&self) -> bool {
        self.connected.load(Ordering::Acquire)
    }

    /// True while this daemon process owns the exact Hub-issued epoch. A
    /// transient socket outage does not surrender the epoch: HTTP pull may use
    /// it until Hub accepts a reconnect/replacement and changes the value.
    pub fn owns_connection_epoch(&self, epoch: u64) -> bool {
        epoch > 0 && self.connection_epoch.load(Ordering::Acquire) == epoch
    }

    pub fn connection_epoch(&self) -> Option<u64> {
        let epoch = self.connection_epoch.load(Ordering::Acquire);
        (epoch > 0 && self.is_connected()).then_some(epoch)
    }

    pub fn claim_connection_epoch(&self) -> Option<u64> {
        let epoch = self.connection_epoch.load(Ordering::Acquire);
        (epoch > 0).then_some(epoch)
    }

    pub fn activation_receipt(&self) -> Option<MachineDaemonActivationReceipt> {
        self.activation_receipt
            .read()
            .ok()
            .and_then(|receipt| receipt.clone())
    }

    fn activation_connection_epoch(&self) -> Result<u64> {
        self.connection_epoch().ok_or_else(|| {
            CliError::RelayTransient("Machine Daemon activation connection is offline".into())
        })
    }

    async fn send_activation_request(
        &self,
        instruction: impl FnOnce(
            String,
            oneshot::Sender<std::result::Result<MachineDaemonActivationReceipt, String>>,
        ) -> ConnectionInstruction,
    ) -> Result<MachineDaemonActivationReceipt> {
        let request_id = uuid::Uuid::new_v4().to_string();
        let (reply, receive) = oneshot::channel();
        self.instruction_tx
            .send(instruction(request_id, reply))
            .map_err(|_| {
                CliError::Relay("Machine Daemon activation connection is closed".into())
            })?;
        activation_reply(receive).await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn prepare_activation(
        &self,
        transaction_id: String,
        artifact_sha256: String,
        run_set_digest: String,
        expected_run_ids: Vec<String>,
        adopted_run_ids: Vec<String>,
        natural_terminal_run_ids: Vec<String>,
        adopted_runs: Vec<MachineDaemonAdoptedRunEvidence>,
    ) -> Result<MachineDaemonActivationReceipt> {
        let connection_epoch = self.activation_connection_epoch()?;
        self.send_activation_request(
            |request_id, reply| ConnectionInstruction::PrepareActivation {
                request_id,
                transaction_id,
                artifact_sha256,
                connection_epoch,
                run_set_digest,
                expected_run_ids,
                adopted_run_ids,
                natural_terminal_run_ids,
                adopted_runs,
                reply,
            },
        )
        .await
    }

    pub async fn begin_activation(
        &self,
        transaction_id: String,
        transaction_nonce: String,
        artifact_sha256: String,
    ) -> Result<MachineDaemonActivationReceipt> {
        let connection_epoch = self.activation_connection_epoch()?;
        self.send_activation_request(|request_id, reply| ConnectionInstruction::BeginActivation {
            request_id,
            transaction_id,
            transaction_nonce,
            artifact_sha256,
            connection_epoch,
            reply,
        })
        .await
    }

    pub async fn advance_activation(
        &self,
        transaction_id: String,
        artifact_sha256: String,
        phase: &str,
    ) -> Result<MachineDaemonActivationReceipt> {
        let connection_epoch = self.activation_connection_epoch()?;
        self.advance_activation_at_epoch(transaction_id, artifact_sha256, connection_epoch, phase)
            .await
    }

    pub async fn advance_activation_at_epoch(
        &self,
        transaction_id: String,
        artifact_sha256: String,
        connection_epoch: u64,
        phase: &str,
    ) -> Result<MachineDaemonActivationReceipt> {
        let receipt = self
            .send_activation_request(
                |request_id, reply| ConnectionInstruction::AdvanceActivation {
                    request_id,
                    transaction_id,
                    artifact_sha256,
                    connection_epoch,
                    phase: phase.to_string(),
                    reply,
                },
            )
            .await?;
        if receipt.phase == "stable_granted"
            && let Ok(mut activation) = self.identity.activation.write()
        {
            *activation = None;
        }
        Ok(receipt)
    }

    /// Returns the current short-lived Machine principal used by this actor.
    ///
    /// The Human enrollment token never leaves the connection actor. Machine
    /// control-plane HTTP callers compose with the actor through this rotated
    /// credential snapshot instead of borrowing Human session authority.
    pub fn machine_credential(&self) -> Result<String> {
        self.machine_credential_rx
            .borrow()
            .clone()
            .ok_or_else(|| {
                CliError::Auth(
                    "Machine Daemon credential is unavailable until the machine connection authenticates"
                        .into(),
                )
            })
    }

    pub async fn wait_for_machine_credential_change(&self, previous: &str) -> Result<String> {
        let mut receiver = self.machine_credential_rx.clone();
        let wait = async {
            loop {
                if let Some(current) = receiver.borrow().clone()
                    && current != previous
                {
                    return Ok(current);
                }
                receiver.changed().await.map_err(|_| {
                    CliError::Auth("Machine Daemon credential rotation stopped".into())
                })?;
            }
        };
        tokio::time::timeout(INITIAL_HANDSHAKE_TIMEOUT, wait)
            .await
            .map_err(|_| CliError::Auth("Timed out rotating Machine Daemon credential".into()))?
    }

    pub fn disconnect(&self) {
        self.connected.store(false, Ordering::Release);
        self.connection_epoch.store(0, Ordering::Release);
        let _ = self.instruction_tx.send(ConnectionInstruction::Close);
        if let Ok(mut slot) = self.task.lock()
            && let Some(task) = slot.take()
        {
            task.abort();
        }
    }
}

impl Drop for MachineDaemonConnectionClient {
    fn drop(&mut self) {
        self.disconnect();
    }
}

async fn handle_machine_daemon_connection_failure(
    ready: &mut Option<oneshot::Sender<std::result::Result<SerializedMachineDaemon, String>>>,
    events: &mpsc::UnboundedSender<MachineDaemonConnectionEvent>,
    reason: String,
    fatal: bool,
    backoff: &mut Duration,
) -> bool {
    crate::websocket::handle_connection_failure(
        ready,
        events,
        reason,
        fatal,
        backoff,
        RECONNECT_MAX,
        machine_daemon_reconnect_events(),
    )
    .await
}

async fn run_machine_daemon_connection(
    connection_url: String,
    enrollment_token: Arc<RwLock<String>>,
    identity: MachineDaemonIdentity,
    mut instruction_rx: mpsc::UnboundedReceiver<ConnectionInstruction>,
    event_tx: mpsc::UnboundedSender<MachineDaemonConnectionEvent>,
    ready_tx: oneshot::Sender<std::result::Result<SerializedMachineDaemon, String>>,
    connected: Arc<AtomicBool>,
    connection_epoch: Arc<AtomicU64>,
    machine_credential_tx: watch::Sender<Option<String>>,
    activation_receipt: Arc<RwLock<Option<MachineDaemonActivationReceipt>>>,
) {
    let mut ready_tx = Some(ready_tx);
    let mut connected_once = false;
    let mut backoff = RECONNECT_BASE;

    loop {
        let current_enrollment_token = match machine_daemon_enrollment_token(&enrollment_token) {
            Ok(token) => token,
            Err(error) => {
                let reason = error.to_string();
                if let Some(sender) = ready_tx.take() {
                    let _ = sender.send(Err(reason));
                } else {
                    let _ = event_tx.send(MachineDaemonConnectionEvent::Error {
                        message: reason,
                        correlation: None,
                    });
                }
                return;
            }
        };
        let enrollment = match mint_machine_daemon_credential(
            &connection_url,
            &current_enrollment_token,
            &identity,
        )
        .await
        {
            Ok(value) => value,
            Err(error) => {
                let upgrade_required = matches!(&error, CliError::UpgradeRequired(_));
                let retired = machine_retired(&error);
                let reason = format!("Machine Daemon credential enrollment failed: {error}");
                if crate::websocket::fail_initial_ready(&mut ready_tx, &reason) {
                    return;
                }
                // A removed Machine stays removed until its owner logs in on
                // it again: stop this profile instead of retrying.
                if retired {
                    let _ = event_tx.send(MachineDaemonConnectionEvent::ShutdownRequested {
                        reason: Some(error.to_string()),
                    });
                    return;
                }
                if upgrade_required {
                    let _ = event_tx.send(MachineDaemonConnectionEvent::Error {
                        message: reason,
                        correlation: None,
                    });
                    return;
                }
                let _ = event_tx.send(MachineDaemonConnectionEvent::Disconnected { reason });
                crate::websocket::wait_before_reconnect(&mut backoff, RECONNECT_MAX).await;
                continue;
            }
        };
        let machine_credential = enrollment.credential;
        let _ = machine_credential_tx.send(Some(machine_credential.clone()));
        // Enrollment is enough to start the daemon and its reconnect actor.
        // Command claims remain fenced until the socket handshake supplies a
        // live Hub epoch; credential issuance must not fabricate one.
        let recovering = identity
            .activation
            .read()
            .ok()
            .is_some_and(|activation| activation.is_some());
        if !recovering
            && let Some(daemon) = enrollment.daemon
            && let Some(sender) = ready_tx.take()
        {
            let _ = sender.send(Ok(daemon));
        }
        let Ok(stream) = crate::websocket::connect_with_reconnect(
            &connection_url,
            crate::websocket::ConnectionOptions {
                component: ClientComponent::Daemon,
                timeout: CONNECT_TIMEOUT,
                timeout_reason: "Machine Daemon connection timed out",
                reconnect_max: RECONNECT_MAX,
            },
            &mut ready_tx,
            &event_tx,
            &mut backoff,
            machine_daemon_reconnect_events(),
        )
        .await
        else {
            return;
        };
        let Some(stream) = stream else {
            continue;
        };

        let (mut write, mut read) = stream.split();
        let connect_message = machine_daemon_connect_message(&machine_credential, &identity);
        let handshake_send = tokio::time::timeout(
            WRITE_TIMEOUT,
            write.send(Message::Text(connect_message.to_string().into())),
        )
        .await;
        if let Err(error) = match handshake_send {
            Ok(result) => result,
            Err(_) => {
                let reason = format!(
                    "Failed to authenticate Machine Daemon: write timed out after {}s",
                    WRITE_TIMEOUT.as_secs()
                );
                if handle_machine_daemon_connection_failure(
                    &mut ready_tx,
                    &event_tx,
                    reason,
                    false,
                    &mut backoff,
                )
                .await
                {
                    return;
                }
                continue;
            }
        } {
            let reason = format!("Failed to authenticate Machine Daemon: {error}");
            if handle_machine_daemon_connection_failure(
                &mut ready_tx,
                &event_tx,
                reason,
                false,
                &mut backoff,
            )
            .await
            {
                return;
            }
            continue;
        }

        let first_text = match crate::websocket::receive_handshake_text(
            &mut read,
            INITIAL_HANDSHAKE_TIMEOUT,
            "Machine Daemon",
            "Machine Daemon connection closed before authentication completed",
        )
        .await
        {
            Ok(text) => text,
            Err(reason) => {
                if crate::websocket::fail_handshake_or_wait(&mut ready_tx, &reason, backoff).await {
                    return;
                }
                continue;
            }
        };

        let (daemon, epoch, receipt) = match parse_machine_daemon_connected(&first_text) {
            Ok(handshake) => handshake,
            Err(reason) => {
                if durable_object_runtime_reset(&reason) {
                    let _ = event_tx.send(MachineDaemonConnectionEvent::Disconnected {
                        reason: format!("Machine Daemon Hub runtime reset: {reason}"),
                    });
                    crate::websocket::wait_before_reconnect(&mut backoff, RECONNECT_MAX).await;
                    continue;
                }
                if crate::websocket::fail_initial_ready(&mut ready_tx, &reason) {
                    return;
                }
                let _ = event_tx.send(MachineDaemonConnectionEvent::Error {
                    message: reason,
                    correlation: None,
                });
                tokio::time::sleep(backoff).await;
                continue;
            }
        };

        connection_epoch.store(epoch, Ordering::Release);
        connected.store(true, Ordering::Release);
        if let Ok(mut slot) = activation_receipt.write() {
            *slot = receipt.clone();
        }
        if let Some(receipt) = receipt {
            let _ = event_tx.send(MachineDaemonConnectionEvent::ActivationReceipt(receipt));
        }
        backoff = RECONNECT_BASE;
        if let Some(sender) = ready_tx.take() {
            let _ = sender.send(Ok(daemon.clone()));
        } else if connected_once {
            let _ = event_tx.send(MachineDaemonConnectionEvent::Reconnected {
                daemon: daemon.clone(),
            });
        }
        connected_once = true;

        let (out_tx, out_rx) = mpsc::channel(WRITE_QUEUE_CAPACITY);
        let (fail_tx, mut fail_rx) = mpsc::channel(1);
        let mut writer = tokio::spawn(async move {
            if let Err(reason) = run_machine_daemon_writer(write, out_rx).await {
                let _ = fail_tx.send(reason).await;
            }
        });
        let mut heartbeat = tokio::time::interval(HEARTBEAT_INTERVAL);
        heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        // A half-open socket delivers neither a close frame nor a read error, so
        // `read.next()` blocks forever and buffered writes keep succeeding. Only
        // inbound traffic proves the Hub is still there. Writes run on a dedicated
        // task so a hung send cannot stall that read/heartbeat select.
        let mut last_server_activity = Instant::now();
        let mut probe_sent_at: Option<Instant> = None;
        let mut pending_renews: HashMap<
            String,
            oneshot::Sender<std::result::Result<String, String>>,
        > = HashMap::new();
        let mut pending_run_reports: PendingRunReports = HashMap::new();
        let mut pending_admissions: HashMap<
            String,
            oneshot::Sender<std::result::Result<String, String>>,
        > = HashMap::new();
        let mut pending_activations: HashMap<
            String,
            oneshot::Sender<std::result::Result<MachineDaemonActivationReceipt, String>>,
        > = HashMap::new();
        let disconnect_reason = loop {
            tokio::select! {
                writer_error = fail_rx.recv() => {
                    break writer_error.unwrap_or_else(|| "Machine Daemon writer closed".into());
                }
                instruction = instruction_rx.recv(), if machine_daemon_accepts_instruction(&out_tx) => {
                    match instruction {
                        Some(ConnectionInstruction::ConfirmRunReport { report, request_id, run_id, reply }) => {
                            let Some(reply) = join_pending_run_report(&mut pending_run_reports, &run_id, reply) else {
                                continue;
                            };
                            if pending_run_reports.len() >= MAX_PENDING_RUN_REPORTS {
                                let _ = reply.send(Err("Too many pending terminal Run reports".into()));
                                continue;
                            }
                            let text = match serde_json::to_string(&report) {
                                Ok(text) => text,
                                Err(error) => { let _ = reply.send(Err(error.to_string())); continue; }
                            };
                            let reply = match enqueue_replied_write(&out_tx, text, reply) {
                                Ok(reply) => reply,
                                Err(error) => break error,
                            };
                            pending_run_reports.insert(run_id, PendingRunReport {
                                request_id, waiters: vec![reply], acked: false,
                            });
                        }
                        Some(ConnectionInstruction::Report(report)) => {
                            let text = match serde_json::to_string(&report) {
                                Ok(value) => value,
                                Err(error) => {
                                    let _ = event_tx.send(MachineDaemonConnectionEvent::Error {
                                        message: format!("Machine Daemon report serialization failed: {error}"),
                                        correlation: None,
                                    });
                                    continue;
                                }
                            };
                            if let Err(error) = enqueue_machine_daemon_write(&out_tx, Message::Text(text.into())) {
                                break error;
                            }
                        }
                        Some(ConnectionInstruction::AdmitCommand { request_id, report, reply }) => {
                            let text = match serde_json::to_string(&report) {
                                Ok(value) => value,
                                Err(error) => {
                                    let _ = reply.send(Err(format!(
                                        "Machine Daemon admission serialization failed: {error}"
                                    )));
                                    continue;
                                }
                            };
                            let reply = match enqueue_replied_write(&out_tx, text, reply) {
                                Ok(reply) => reply,
                                Err(error) => break error,
                            };
                            pending_admissions.insert(request_id, reply);
                        }
                        Some(ConnectionInstruction::RenewLease {
                            request_id,
                            control_id,
                            relay_lease,
                            reply,
                        }) => {
                            let message = serde_json::json!({
                                "type": "machine_command_lease_renew",
                                "requestId": request_id,
                                "controlId": control_id,
                                "relayLease": relay_lease,
                            });
                            if let Err(error) = enqueue_machine_daemon_request(
                                &out_tx, request_id, message, reply, &mut pending_renews,
                            ) {
                                break error;
                            }
                        }
                        Some(ConnectionInstruction::PrepareActivation {
                            request_id,
                            transaction_id,
                            artifact_sha256,
                            connection_epoch,
                            run_set_digest,
                            expected_run_ids,
                            adopted_run_ids,
                            natural_terminal_run_ids,
                            adopted_runs,
                            reply,
                        }) => {
                            let message = serde_json::json!({
                                "type": "machine_activation_prepare",
                                "requestId": request_id,
                                "transactionId": transaction_id,
                                "artifactSha256": artifact_sha256,
                                "connectionEpoch": connection_epoch,
                                "runSetDigest": run_set_digest,
                                "expectedRunIds": expected_run_ids,
                                "adoptedRunIds": adopted_run_ids,
                                "naturalTerminalRunIds": natural_terminal_run_ids,
                                "adoptedRuns": adopted_runs,
                            });
                            if let Err(error) = enqueue_machine_daemon_request(
                                &out_tx, request_id, message, reply, &mut pending_activations,
                            ) {
                                break error;
                            }
                        }
                        Some(ConnectionInstruction::BeginActivation {
                            request_id,
                            transaction_id,
                            transaction_nonce,
                            artifact_sha256,
                            connection_epoch,
                            reply,
                        }) => {
                            let message = serde_json::json!({
                                "type": "machine_activation_begin",
                                "requestId": request_id,
                                "transactionId": transaction_id,
                                "transactionNonce": transaction_nonce,
                                "artifactSha256": artifact_sha256,
                                "sourceConnectionEpoch": connection_epoch,
                            });
                            if let Err(error) = enqueue_machine_daemon_request(
                                &out_tx, request_id, message, reply, &mut pending_activations,
                            ) {
                                break error;
                            }
                        }
                        Some(ConnectionInstruction::AdvanceActivation {
                            request_id,
                            transaction_id,
                            artifact_sha256,
                            connection_epoch,
                            phase,
                            reply,
                        }) => {
                            let message = serde_json::json!({
                                "type": "machine_activation_advance",
                                "requestId": request_id,
                                "transactionId": transaction_id,
                                "artifactSha256": artifact_sha256,
                                "connectionEpoch": connection_epoch,
                                "phase": phase,
                            });
                            if let Err(error) = enqueue_machine_daemon_request(
                                &out_tx, request_id, message, reply, &mut pending_activations,
                            ) {
                                break error;
                            }
                        }
                        Some(ConnectionInstruction::RefreshAuthCredential(credential)) => {
                            let message = serde_json::json!({
                                "type": "refresh_auth",
                                "requestId": uuid::Uuid::new_v4().to_string(),
                                "token": credential.clone(),
                            });
                            if let Err(error) = enqueue_machine_daemon_write(
                                &out_tx,
                                Message::Text(message.to_string().into()),
                            ) {
                                break error;
                            }
                            let _ = machine_credential_tx.send(Some(credential));
                        }
                        Some(ConnectionInstruction::Retired(reason)) => {
                            let _ = event_tx.send(MachineDaemonConnectionEvent::ShutdownRequested {
                                reason: Some(reason),
                            });
                            connected.store(false, Ordering::Release);
                            abort_machine_daemon_writer(writer).await;
                            return;
                        }
                        Some(ConnectionInstruction::Close) | None => {
                            let unregister = serde_json::json!({
                                "type": "unregister",
                                "requestId": uuid::Uuid::new_v4().to_string(),
                            });
                            let _ = enqueue_machine_daemon_write(
                                &out_tx,
                                Message::Text(unregister.to_string().into()),
                            );
                            drop(out_tx);
                            match tokio::time::timeout(WRITE_TIMEOUT, &mut writer).await {
                                Ok(_) => {}
                                Err(_) => {
                                    writer.abort();
                                    let _ = writer.await;
                                }
                            }
                            connected.store(false, Ordering::Release);
                            connection_epoch.store(0, Ordering::Release);
                            fail_pending_requests(
                                &mut pending_renews,
                                "Machine Daemon control connection closed",
                            );
                            fail_pending_requests(
                                &mut pending_admissions,
                                "Machine Daemon control connection closed",
                            );
                            fail_pending_requests(
                                &mut pending_activations,
                                "Machine Daemon control connection closed",
                            );
                            return;
                        }
                    }
                }
                incoming = read.next() => {
                    match incoming {
                        Some(Ok(message)) => {
                            // Any frame at all — including a pong the edge answers
                            // below the Durable Object — proves the socket is live.
                            last_server_activity = Instant::now();
                            probe_sent_at = None;
                            if let Message::Close(frame) = &message
                                && http::is_upgrade_required_close(frame.as_ref())
                            {
                                connected.store(false, Ordering::Release);
                                connection_epoch.store(0, Ordering::Release);
                                let reason = frame
                                    .as_ref()
                                    .map(|frame| frame.reason.to_string())
                                    .filter(|reason| !reason.is_empty())
                                    .unwrap_or_else(|| "This xMatrix daemon must be updated before reconnecting.".into());
                                let _ = event_tx.send(MachineDaemonConnectionEvent::Error { message: reason, correlation: None });
                                abort_machine_daemon_writer(writer).await;
                                return;
                            }
                            if message.is_close() {
                                break "Machine Daemon connection closed by Hub".to_string();
                            }
                            if let Ok(text) = message.into_text() {
                                if resolve_pending_run_report(&mut pending_run_reports, text.as_ref()) {
                                    continue;
                                }
                                if resolve_pending_command_admission(
                                    &mut pending_admissions,
                                    text.as_ref(),
                                ) {
                                    continue;
                                }
                                if resolve_pending_lease_renew(&mut pending_renews, text.as_ref()) {
                                    continue;
                                }
                                if let Some(receipt) = resolve_pending_activation(
                                    &mut pending_activations,
                                    text.as_ref(),
                                ) {
                                    if let Ok(mut slot) = activation_receipt.write() {
                                        *slot = Some(receipt.clone());
                                    }
                                    let _ = event_tx.send(
                                        MachineDaemonConnectionEvent::ActivationReceipt(receipt),
                                    );
                                    continue;
                                }
                                if let Some(event) = parse_machine_daemon_server_event(text.as_ref())
                            {
                                if let MachineDaemonConnectionEvent::Error { message, .. } = &event
                                    && durable_object_runtime_reset(message)
                                {
                                    break format!(
                                        "Machine Daemon Hub runtime reset: {message}"
                                    );
                                }
                                let shutdown = matches!(event, MachineDaemonConnectionEvent::ShutdownRequested { .. });
                                let _ = event_tx.send(event);
                                if shutdown {
                                    connected.store(false, Ordering::Release);
                                    abort_machine_daemon_writer(writer).await;
                                    return;
                                }
                            }
                            }
                        }
                        Some(Err(error)) => break format!("Machine Daemon read failed: {error}"),
                        None => break "Machine Daemon connection ended".to_string(),
                    }
                }
                _ = heartbeat.tick() => {
                    if let Some(sent_at) = probe_sent_at {
                        // The probe is answered by clearing `probe_sent_at`, so
                        // reaching here with one outstanding means the Hub never
                        // replied to a frame it always replies to.
                        let waited = sent_at.elapsed();
                        if waited >= HEARTBEAT_PROBE_TIMEOUT {
                            break format!(
                                "Machine Daemon heartbeat timed out; the Hub did not answer a liveness probe sent {}s ago",
                                waited.as_secs()
                            );
                        }
                        continue;
                    }
                    let silence = last_server_activity.elapsed();
                    let probe = silence >= HEARTBEAT_PROBE_AFTER;
                    let frame = if probe {
                        machine_daemon_liveness_probe_frame()
                    } else {
                        machine_daemon_heartbeat_frame()
                    };
                    match enqueue_machine_daemon_heartbeat(&out_tx, frame) {
                        Ok(true) if probe => probe_sent_at = Some(Instant::now()),
                        Ok(_) => {}
                        Err(error) => break format!("Machine Daemon heartbeat failed: {error}"),
                    }
                }
            }
        };

        abort_machine_daemon_writer(writer).await;
        mark_machine_daemon_transport_offline(&connected);
        fail_pending_requests(&mut pending_renews, &disconnect_reason);
        fail_pending_requests(&mut pending_admissions, &disconnect_reason);
        fail_pending_requests(&mut pending_activations, &disconnect_reason);
        let _ = event_tx.send(MachineDaemonConnectionEvent::Disconnected {
            reason: disconnect_reason,
        });
        crate::websocket::wait_before_reconnect(&mut backoff, RECONNECT_MAX).await;
    }
}

fn machine_daemon_enrollment_token(source: &Arc<RwLock<String>>) -> Result<String> {
    source
        .read()
        .map(|token| token.clone())
        .map_err(|_| CliError::Relay("Machine Daemon auth state poisoned".into()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MachineDaemonCredentialResponse {
    credential: String,
    #[serde(default)]
    daemon: Option<SerializedMachineDaemon>,
    /// Legacy Machine ids the Hub adopted (or had already adopted) into this Machine.
    #[serde(default, rename = "adoptedMachineIds")]
    adopted_machine_ids: Vec<String>,
}

fn machine_daemon_hub_url(connection_url: &str) -> Result<String> {
    let trimmed = connection_url.trim();
    let (scheme, remainder) = if let Some(value) = trimmed.strip_prefix("wss://") {
        ("https", value)
    } else if let Some(value) = trimmed.strip_prefix("ws://") {
        ("http", value)
    } else {
        return Err(CliError::Relay(
            "Machine Daemon connection URL must use ws:// or wss://".into(),
        ));
    };
    let authority = remainder
        .split(['/', '?', '#'])
        .next()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| CliError::Relay("Machine Daemon connection URL has no host".into()))?;
    Ok(format!("{scheme}://{authority}"))
}

/// Hub's refusal for a Machine its owner removed; the daemon stops on it
/// instead of retrying. Matches `MACHINE_RETIRED_MESSAGE` in packages/db.
const MACHINE_RETIRED_MARKER: &str = "This Machine was removed from its owner's xMatrix account.";

fn machine_retired(error: &CliError) -> bool {
    matches!(error, CliError::Http(message) if message.contains(MACHINE_RETIRED_MARKER))
}

async fn mint_machine_daemon_credential(
    connection_url: &str,
    enrollment_token: &str,
    identity: &MachineDaemonIdentity,
) -> Result<MachineDaemonCredentialResponse> {
    let hub_url = machine_daemon_hub_url(connection_url)?;
    crate::machine_naming::require_machine_name(&hub_url, enrollment_token, &identity.machine_id)
        .await?;
    let url = with_route(&hub_url, HubRoutes::MACHINE_DAEMON_CREDENTIALS);
    // Hostname is an observation; enrollment identity is owner + machineId.
    let body = serde_json::json!({
        "machineId": identity.machine_id,
        "hostname": identity.hostname,
    });
    // Ids earlier CLIs minted in this config directory: the Hub moves their
    // records to this Machine before enrolling it. They are forgotten only once
    // the Hub names them adopted; a Hub without adoption names none.
    let legacy = crate::config::pending_legacy_machine_ids(&identity.machine_id).await;
    let response: MachineDaemonCredentialResponse = if legacy.is_empty() {
        crate::http::request_json(&url, "POST", Some(enrollment_token), Some(body)).await?
    } else {
        let mut adopting = body.clone();
        adopting["legacyMachineIds"] = serde_json::json!(legacy);
        match crate::http::request_json::<MachineDaemonCredentialResponse>(
            &url,
            "POST",
            Some(enrollment_token),
            Some(adopting),
        )
        .await
        {
            Ok(response) => {
                if let Err(error) =
                    crate::config::forget_legacy_machine_ids(&response.adopted_machine_ids).await
                {
                    eprintln!("Warning: could not forget adopted legacy Machine ids: {error}");
                }
                response
            }
            Err(error @ CliError::UpgradeRequired(_)) => return Err(error),
            Err(error) => {
                // Adoption is retried at the next mint; the daemon still starts.
                eprintln!("Warning: legacy Machine ids were not adopted: {error}");
                crate::http::request_json(&url, "POST", Some(enrollment_token), Some(body)).await?
            }
        }
    };
    if response.credential.trim().is_empty() {
        return Err(CliError::Relay(
            "Hub returned an empty Machine Daemon credential".into(),
        ));
    }
    Ok(response)
}

fn machine_daemon_connect_message(
    token: &str,
    identity: &MachineDaemonIdentity,
) -> serde_json::Value {
    let mut message = serde_json::json!({
        "type": "machine_daemon_connect",
        "requestId": uuid::Uuid::new_v4().to_string(),
        "token": token,
        "displayName": identity.display_name,
        "machineId": identity.machine_id,
        "hostname": identity.hostname,
        "clientVersion": crate::version::current(),
        "protocolVersion": CLIENT_COMPATIBILITY_PROTOCOL_VERSION,
        "capabilities": identity.capabilities,
        "machineMetadata": identity.metadata.read().ok().and_then(|slot| slot.clone()),
    });
    if let Ok(activation) = identity.activation.read()
        && let Some(activation) = activation.as_ref()
    {
        message["activation"] = serde_json::json!(activation);
    }
    message
}

fn parse_machine_daemon_connected(
    text: &str,
) -> std::result::Result<
    (
        SerializedMachineDaemon,
        u64,
        Option<MachineDaemonActivationReceipt>,
    ),
    String,
> {
    #[derive(Deserialize)]
    #[serde(tag = "type", rename_all = "snake_case")]
    enum Handshake {
        MachineDaemonConnected {
            daemon: SerializedMachineDaemon,
            #[serde(rename = "connectionEpoch")]
            connection_epoch: u64,
            #[serde(default)]
            activation: Option<MachineDaemonActivationReceipt>,
        },
        Error {
            message: String,
        },
        ShutdownRequested {
            reason: Option<String>,
        },
    }

    match serde_json::from_str::<Handshake>(text) {
        Ok(Handshake::MachineDaemonConnected {
            daemon,
            connection_epoch,
            activation,
        }) if connection_epoch > 0 => Ok((daemon, connection_epoch, activation)),
        Ok(Handshake::MachineDaemonConnected { .. }) => {
            Err("Invalid Machine Daemon connection epoch".to_string())
        }
        Ok(Handshake::Error { message }) => Err(message),
        Ok(Handshake::ShutdownRequested { reason }) => Err(reason
            .map(|value| format!("Machine Daemon shutdown requested: {value}"))
            .unwrap_or_else(|| "Machine Daemon shutdown requested".to_string())),
        Err(error) => Err(format!("Invalid Machine Daemon handshake: {error}")),
    }
}

fn map_socket_lease_renew_error(error: &str) -> CliError {
    let lower = error.to_ascii_lowercase();
    if lower.contains("stale")
        || lower.contains("not found")
        || lower.contains("does not own")
        || lower.contains("epoch")
        || lower.contains("fence")
        || lower.contains("upgrade required")
    {
        CliError::Launch(error.to_string())
    } else {
        CliError::RelayTransient(error.to_string())
    }
}

async fn activation_reply(
    receive: oneshot::Receiver<std::result::Result<MachineDaemonActivationReceipt, String>>,
) -> Result<MachineDaemonActivationReceipt> {
    match tokio::time::timeout(INITIAL_HANDSHAKE_TIMEOUT, receive).await {
        Ok(Ok(Ok(receipt))) => Ok(receipt),
        Ok(Ok(Err(error))) => Err(CliError::Relay(error)),
        Ok(Err(_)) => Err(CliError::RelayTransient(
            "Machine Daemon activation request was cancelled".into(),
        )),
        Err(_) => Err(CliError::RelayTransient(
            "Machine Daemon activation request timed out".into(),
        )),
    }
}

fn fail_pending_requests<T>(
    pending: &mut HashMap<String, oneshot::Sender<std::result::Result<T, String>>>,
    reason: &str,
) {
    for (_, reply) in pending.drain() {
        let _ = reply.send(Err(reason.to_string()));
    }
}

fn resolve_pending_activation(
    pending: &mut HashMap<
        String,
        oneshot::Sender<std::result::Result<MachineDaemonActivationReceipt, String>>,
    >,
    text: &str,
) -> Option<MachineDaemonActivationReceipt> {
    let value = serde_json::from_str::<serde_json::Value>(text).ok()?;
    let request_id = value.get("requestId")?.as_str()?;
    if !pending.contains_key(request_id) {
        return None;
    }
    match value.get("type")?.as_str()? {
        "machine_activation_receipt" => {
            let reply = pending.remove(request_id)?;
            match serde_json::from_value::<MachineDaemonActivationReceipt>(value) {
                Ok(receipt) => {
                    let _ = reply.send(Ok(receipt.clone()));
                    Some(receipt)
                }
                Err(error) => {
                    let _ = reply.send(Err(format!(
                        "Invalid Machine Daemon activation receipt: {error}"
                    )));
                    None
                }
            }
        }
        "error" => {
            let reply = pending.remove(request_id)?;
            let message = value
                .get("message")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("Machine Daemon activation failed")
                .to_string();
            let _ = reply.send(Err(message));
            None
        }
        _ => None,
    }
}

fn parse_correlated_reply(text: &str) -> Option<(serde_json::Value, String)> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    let request_id = value.get("requestId")?.as_str()?.to_string();
    Some((value, request_id))
}

type PendingStringReplies = HashMap<String, oneshot::Sender<std::result::Result<String, String>>>;

fn resolve_pending_lease_renew(pending: &mut PendingStringReplies, text: &str) -> bool {
    let Some((value, request_id)) = parse_correlated_reply(text) else {
        return false;
    };
    let Some(kind) = value.get("type").and_then(serde_json::Value::as_str) else {
        return false;
    };

    match kind {
        "machine_command_lease_renewed" => {
            let Some(reply) = pending.remove(&request_id) else {
                return false;
            };
            let lease_until = value
                .get("leaseUntil")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_string();
            if lease_until.is_empty() {
                let _ = reply.send(Err("Machine Daemon lease renewal omitted leaseUntil".into()));
            } else {
                let _ = reply.send(Ok(lease_until));
            }
            true
        }
        "error" if pending.contains_key(&request_id) => {
            let reply = pending.remove(&request_id).expect("contains_key");
            let message = value
                .get("message")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("Machine Daemon lease renewal failed")
                .to_string();
            let _ = reply.send(Err(message));
            true
        }
        _ => false,
    }
}

/// Terminal reports in flight on this connection, one per Run. A caller that
/// stops waiting (its 30 s bound) leaves the report in flight: sending another
/// copy of the same exit would only lengthen the queue that delayed the first
/// receipt, and a receipt that arrives late still settles the Run for the next
/// caller instead of being dropped.
type PendingRunReports = HashMap<String, PendingRunReport>;

struct PendingRunReport {
    request_id: String,
    waiters: Vec<oneshot::Sender<std::result::Result<(), String>>>,
    /// Hub acknowledged the report after every waiter had given up.
    acked: bool,
}

/// Runs, each with at most one report in flight: bounded by the Hub's live
/// Run capacity per Machine.
const MAX_PENDING_RUN_REPORTS: usize = 1024;

/// Joins `reply` to the report already in flight for `run_id`, or answers it
/// from a receipt that arrived late. Returns `reply` when a new report must be
/// sent.
fn join_pending_run_report(
    pending: &mut PendingRunReports,
    run_id: &str,
    reply: oneshot::Sender<std::result::Result<(), String>>,
) -> Option<oneshot::Sender<std::result::Result<(), String>>> {
    let Some(entry) = pending.get_mut(run_id) else {
        return Some(reply);
    };
    if entry.acked {
        pending.remove(run_id);
        let _ = reply.send(Ok(()));
        return None;
    }
    entry.waiters.retain(|waiter| !waiter.is_closed());
    entry.waiters.push(reply);
    None
}

fn resolve_pending_run_report(pending: &mut PendingRunReports, text: &str) -> bool {
    let Some((value, request_id)) = parse_correlated_reply(text) else {
        return false;
    };

    let Some(run_id) = pending
        .iter()
        .find(|(_, entry)| entry.request_id == request_id && !entry.acked)
        .map(|(run_id, _)| run_id.clone())
    else {
        return false;
    };
    let result = match value.get("type").and_then(serde_json::Value::as_str) {
        Some("machine_run_report_acked")
            if value.get("runId").and_then(serde_json::Value::as_str) == Some(run_id.as_str()) =>
        {
            Ok(())
        }
        Some("error") => Err(value
            .get("message")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("Terminal Run finalization failed")
            .to_string()),
        _ => return false,
    };
    let Some(mut entry) = pending.remove(&run_id) else {
        return true;
    };
    entry.waiters.retain(|waiter| !waiter.is_closed());
    if entry.waiters.is_empty() {
        // Nobody is waiting: keep a receipt for the next caller; a failure
        // simply lets that caller send the report again.
        if result.is_ok() {
            entry.acked = true;
            pending.insert(run_id, entry);
        }
        return true;
    }
    for waiter in entry.waiters {
        let _ = waiter.send(result.clone());
    }
    true
}

fn resolve_pending_command_admission(pending: &mut PendingStringReplies, text: &str) -> bool {
    let Some((value, request_id)) = parse_correlated_reply(text) else {
        return false;
    };

    let Some(reply) = pending.remove(&request_id) else {
        return false;
    };
    if value.get("type").and_then(serde_json::Value::as_str)
        == Some("machine_command_admission_acked")
    {
        let lease_until = value
            .get("leaseUntil")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string();
        let _ = if lease_until.is_empty() {
            reply.send(Err("Machine Daemon admission omitted leaseUntil".into()))
        } else {
            reply.send(Ok(lease_until))
        };
    } else {
        let message = value
            .get("message")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("Machine Daemon admission failed")
            .to_string();
        let _ = reply.send(Err(message));
    }
    true
}

fn parse_machine_daemon_server_event(text: &str) -> Option<MachineDaemonConnectionEvent> {
    let value = serde_json::from_str::<serde_json::Value>(text).ok()?;
    match value.get("type")?.as_str()? {
        "machine_spawn_agent"
        | "machine_stop_agent"
        | "machine_request_resolve"
        | "machine_quota_probe"
        | "machine_harness_action"
        | "machine_recover_reply"
        | "machine_worktree_cleanup" => Some(
            match serde_json::from_value::<MachineDaemonCommand>(value) {
                Ok(command) => MachineDaemonConnectionEvent::Command(command),
                Err(error) => MachineDaemonConnectionEvent::Error {
                    message: format!("Invalid Machine Daemon command: {error}"),
                    correlation: None,
                },
            },
        ),
        "error" => {
            let message = value
                .get("message")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("Machine Daemon connection error")
                .to_string();
            let request_id = value.get("requestId").and_then(serde_json::Value::as_str);
            let diagnostic_id = value
                .pointer("/failure/diagnosticId")
                .and_then(serde_json::Value::as_str);
            let correlation = match (request_id, diagnostic_id) {
                (None, None) => None,
                (request_id, diagnostic_id) => Some(format!(
                    "requestId={}, diagnosticId={}",
                    request_id.unwrap_or("-"),
                    diagnostic_id.unwrap_or("-")
                )),
            };
            Some(match request_id {
                Some(request_id)
                    if request_id.starts_with(MACHINE_REQUEST_NOTICE_REPORT_PREFIX) =>
                {
                    MachineDaemonConnectionEvent::RequestNoticeDelivery {
                        request_id: request_id.to_string(),
                        result: Err(match diagnostic_id {
                            Some(diagnostic_id) => {
                                format!("{message} (diagnosticId={diagnostic_id})")
                            }
                            None => message,
                        }),
                    }
                }
                _ => MachineDaemonConnectionEvent::Error {
                    message,
                    correlation,
                },
            })
        }
        "machine_request_notice_accepted" => {
            let request_id = value.get("requestId").and_then(serde_json::Value::as_str)?;
            let message_id = value.get("messageId").and_then(serde_json::Value::as_str)?;
            Some(MachineDaemonConnectionEvent::RequestNoticeDelivery {
                request_id: request_id.to_string(),
                result: Ok(message_id.to_string()),
            })
        }
        "shutdown_requested" => Some(MachineDaemonConnectionEvent::ShutdownRequested {
            reason: value
                .get("reason")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string),
        }),
        "machine_command_completion_acked" => value
            .get("controlId")
            .and_then(serde_json::Value::as_str)
            .map(
                |control_id| MachineDaemonConnectionEvent::CommandCompletionAcked {
                    control_id: control_id.to_string(),
                },
            ),
        "pong" | "auth_refreshed" | "unregistered" => None,
        _ => None,
    }
}

fn machine_daemon_reconnect_events()
-> crate::websocket::ReconnectEvents<MachineDaemonConnectionEvent> {
    crate::websocket::ReconnectEvents {
        disconnected: |reason| MachineDaemonConnectionEvent::Disconnected { reason },
        error: |reason| MachineDaemonConnectionEvent::Error {
            message: reason,
            correlation: None,
        },
    }
}

#[cfg(test)]
mod tests {
    fn test_machine_daemon_client() -> super::MachineDaemonConnectionClient {
        super::MachineDaemonConnectionClient::new(
            "wss://example.test/ws".to_string(),
            "token".to_string(),
            "daemon".to_string(),
            "machine-1".to_string(),
            "host-1".to_string(),
            None,
            Vec::new(),
        )
    }

    use super::*;

    #[test]
    fn only_the_hub_refusal_for_a_removed_machine_stops_the_daemon() {
        assert!(machine_retired(&CliError::Http(
            "This Machine was removed from its owner's xMatrix account. Run `xmatrix login` on it to add it back."
                .into()
        )));
        assert!(!machine_retired(&CliError::Http(
            "Machine not found".into()
        )));
        assert!(!machine_retired(&CliError::Relay(
            "This Machine was removed from its owner's xMatrix account.".into()
        )));
    }

    fn pending_report(
        sender: oneshot::Sender<std::result::Result<(), String>>,
    ) -> PendingRunReports {
        PendingRunReports::from([(
            "run-1".into(),
            PendingRunReport {
                request_id: "request-1".into(),
                waiters: vec![sender],
                acked: false,
            },
        )])
    }

    #[tokio::test]
    async fn terminal_receipt_requires_exact_request_and_run() {
        let (sender, receiver) = oneshot::channel();
        let mut pending = pending_report(sender);
        for frame in [
            r#"{"type":"machine_run_report_acked","requestId":"other","runId":"run-1"}"#,
            r#"{"type":"machine_run_report_acked","requestId":"request-1","runId":"other"}"#,
            r#"{"type":"machine_command_completion_acked","requestId":"request-1","controlId":"run-1"}"#,
        ] {
            assert!(!resolve_pending_run_report(&mut pending, frame));
            assert_eq!(pending.len(), 1);
        }
        assert!(resolve_pending_run_report(
            &mut pending,
            r#"{"type":"machine_run_report_acked","requestId":"request-1","runId":"run-1"}"#
        ));
        assert_eq!(receiver.await.unwrap(), Ok(()));
        assert!(pending.is_empty());
    }

    #[tokio::test]
    async fn terminal_finalization_error_is_retryable_not_a_receipt() {
        let (sender, receiver) = oneshot::channel();
        let mut pending = pending_report(sender);
        assert!(resolve_pending_run_report(
            &mut pending,
            r#"{"type":"error","requestId":"request-1","message":"Router unavailable"}"#
        ));
        assert_eq!(receiver.await.unwrap(), Err("Router unavailable".into()));
        assert!(pending.is_empty());
    }

    #[tokio::test]
    async fn a_retry_while_the_report_is_in_flight_waits_for_it_instead_of_resending() {
        let (first, first_receiver) = oneshot::channel();
        let mut pending = pending_report(first);
        // The first caller gave up waiting; its report is still queued at Hub.
        drop(first_receiver);
        let (second, second_receiver) = oneshot::channel();
        assert!(join_pending_run_report(&mut pending, "run-1", second).is_none());
        assert_eq!(pending.len(), 1);
        assert!(resolve_pending_run_report(
            &mut pending,
            r#"{"type":"machine_run_report_acked","requestId":"request-1","runId":"run-1"}"#
        ));
        assert_eq!(second_receiver.await.unwrap(), Ok(()));
        assert!(pending.is_empty());
        // Another Run still sends its own report.
        let (other, _other_receiver) = oneshot::channel();
        assert!(join_pending_run_report(&mut pending, "run-2", other).is_some());
    }

    #[tokio::test]
    async fn a_receipt_that_arrives_after_every_caller_gave_up_settles_the_next_call() {
        let (first, first_receiver) = oneshot::channel();
        let mut pending = pending_report(first);
        drop(first_receiver);
        assert!(resolve_pending_run_report(
            &mut pending,
            r#"{"type":"machine_run_report_acked","requestId":"request-1","runId":"run-1"}"#
        ));
        assert_eq!(pending.len(), 1);
        let (next, next_receiver) = oneshot::channel();
        assert!(join_pending_run_report(&mut pending, "run-1", next).is_none());
        assert_eq!(next_receiver.await.unwrap(), Ok(()));
        assert!(pending.is_empty());
    }

    #[tokio::test]
    async fn a_failure_nobody_waits_for_lets_the_next_call_send_again() {
        let (first, first_receiver) = oneshot::channel();
        let mut pending = pending_report(first);
        drop(first_receiver);
        assert!(resolve_pending_run_report(
            &mut pending,
            r#"{"type":"error","requestId":"request-1","message":"Router unavailable"}"#
        ));
        assert!(pending.is_empty());
        let (next, _next_receiver) = oneshot::channel();
        assert!(join_pending_run_report(&mut pending, "run-1", next).is_some());
    }

    #[test]
    fn disconnected_retry_reads_the_rotated_enrollment_token() {
        let token = Arc::new(RwLock::new("expired".to_string()));
        assert_eq!(machine_daemon_enrollment_token(&token).unwrap(), "expired");

        *token.write().unwrap() = "refreshed".to_string();

        assert_eq!(
            machine_daemon_enrollment_token(&token).unwrap(),
            "refreshed"
        );
    }

    #[test]
    fn machine_heartbeat_uses_websocket_protocol_ping() {
        assert!(matches!(machine_daemon_heartbeat_frame(), Message::Ping(_)));
    }

    #[test]
    fn liveness_probe_is_the_ping_the_hub_answers() {
        let Message::Text(text) = machine_daemon_liveness_probe_frame() else {
            panic!("liveness probe must be a text frame the Durable Object parses");
        };
        let value: serde_json::Value =
            serde_json::from_str(text.as_str()).expect("liveness probe must be JSON");
        // The Hub replies `pong` to exactly this type, which is what makes the
        // absence of a reply evidence rather than ambiguity.
        assert_eq!(value["type"], "ping");
        assert!(
            value["requestId"].as_str().is_some_and(|id| !id.is_empty()),
            "the Hub echoes requestId on its pong",
        );
    }

    #[tokio::test]
    async fn command_admission_waits_for_the_exact_acknowledgement() {
        let (reply_tx, reply_rx) = oneshot::channel();
        let mut pending = HashMap::from([("admit:spawn-1".to_string(), reply_tx)]);
        assert!(!resolve_pending_command_admission(
            &mut pending,
            r#"{"type":"pong","requestId":"other"}"#,
        ));
        assert!(resolve_pending_command_admission(
            &mut pending,
            r#"{"type":"machine_command_admission_acked","requestId":"admit:spawn-1","controlId":"spawn-1","leaseUntil":"2026-09-04T01:00:00.000Z"}"#,
        ));
        assert_eq!(reply_rx.await.unwrap().unwrap(), "2026-09-04T01:00:00.000Z");
    }

    #[test]
    fn probe_escalation_stays_off_the_steady_state_path() {
        // A protocol ping that Cloudflare answers below the Durable Object keeps
        // silence under the escalation threshold, so a healthy idle connection
        // never wakes a hibernated Relay Runtime.
        assert!(HEARTBEAT_PROBE_AFTER > HEARTBEAT_INTERVAL);
    }

    #[test]
    fn write_timeout_matches_the_half_open_bound() {
        assert_eq!(WRITE_TIMEOUT, Duration::from_secs(10));
        assert_eq!(WRITE_QUEUE_CAPACITY, 64);
    }

    #[tokio::test]
    async fn a_full_write_queue_pauses_instructions_instead_of_disconnecting() {
        // #3208: a backlog replayed on reconnect filled the queue, the Full
        // error dropped the connection, and the backlog was replayed again.
        let (tx, mut rx) = mpsc::channel(WRITE_QUEUE_CAPACITY);
        let mut queued = 0;
        while machine_daemon_accepts_instruction(&tx) {
            enqueue_machine_daemon_write(&tx, machine_daemon_heartbeat_frame())
                .expect("an accepted instruction always finds room");
            queued += 1;
        }
        assert_eq!(queued, WRITE_QUEUE_CAPACITY - HEARTBEAT_WRITE_RESERVE);
        // The reserved slot still takes the heartbeat; after that it is skipped,
        // not a disconnect.
        assert_eq!(
            enqueue_machine_daemon_heartbeat(&tx, machine_daemon_heartbeat_frame()),
            Ok(true)
        );
        assert_eq!(
            enqueue_machine_daemon_heartbeat(&tx, machine_daemon_heartbeat_frame()),
            Ok(false)
        );
        // As the writer drains, instructions flow again.
        rx.recv().await.expect("queued frame");
        rx.recv().await.expect("queued frame");
        assert!(machine_daemon_accepts_instruction(&tx));
        drop(rx);
        assert!(enqueue_machine_daemon_heartbeat(&tx, machine_daemon_heartbeat_frame()).is_err());
    }

    #[tokio::test]
    async fn enqueue_fails_when_the_writer_channel_is_closed() {
        let (tx, rx) = mpsc::channel(1);
        drop(rx);
        let error = enqueue_machine_daemon_write(&tx, machine_daemon_heartbeat_frame())
            .expect_err("closed writer must not accept frames");
        assert!(error.contains("writer closed"), "{error}");
    }

    #[test]
    fn half_open_detection_is_bounded_in_ten_seconds() {
        // Both thresholds are only ever sampled on the heartbeat tick, so the
        // bound is not their plain sum.
        //
        // Escalation: tick phase is unrelated to when the last frame arrived, so
        // the first sample at or past HEARTBEAT_PROBE_AFTER can be a whole
        // interval late.
        let escalation = HEARTBEAT_PROBE_AFTER + HEARTBEAT_INTERVAL;
        // Probe timeout: the probe leaves on a tick, so the deadline is reached
        // on the first tick multiple at or past HEARTBEAT_PROBE_TIMEOUT.
        let interval_secs = HEARTBEAT_INTERVAL.as_secs();
        let probe = Duration::from_secs(
            HEARTBEAT_PROBE_TIMEOUT.as_secs().div_ceil(interval_secs) * interval_secs,
        );
        // Derived from the constants rather than hard-coded, so retuning any
        // threshold moves this bound instead of silently invalidating it. The
        // defect this replaces let a half-open socket survive for tens of
        // minutes, until TCP writes finally failed.
        assert_eq!(escalation + probe, Duration::from_secs(10));
    }

    #[test]
    fn machine_connection_url_discards_agent_paths() {
        assert_eq!(
            derive_connection_url("wss://hub.example.com/ws/agent-instances?stale=1"),
            "wss://hub.example.com/ws/machine-daemons"
        );
    }

    #[test]
    fn lease_renew_reply_completes_the_pending_socket_request() {
        let mut pending = HashMap::new();
        let (tx, rx) = oneshot::channel();
        pending.insert("r1".to_string(), tx);
        assert!(resolve_pending_lease_renew(
            &mut pending,
            r#"{"type":"machine_command_lease_renewed","requestId":"r1","controlId":"spawn-1","leaseUntil":"2026-08-16T07:00:00.000Z"}"#,
        ));
        assert!(pending.is_empty());
        assert_eq!(
            rx.blocking_recv().unwrap().unwrap(),
            "2026-08-16T07:00:00.000Z"
        );
    }

    #[test]
    fn lease_renew_error_with_request_id_completes_pending() {
        let mut pending = HashMap::new();
        let (tx, rx) = oneshot::channel();
        pending.insert("r1".to_string(), tx);
        assert!(resolve_pending_lease_renew(
            &mut pending,
            r#"{"type":"error","requestId":"r1","message":"Unsupported Machine Daemon connection message"}"#,
        ));
        assert!(
            rx.blocking_recv()
                .unwrap()
                .unwrap_err()
                .contains("Unsupported")
        );
    }

    #[test]
    fn lease_renew_error_without_pending_request_is_ignored() {
        let mut pending =
            HashMap::<String, oneshot::Sender<std::result::Result<String, String>>>::new();
        assert!(!resolve_pending_lease_renew(
            &mut pending,
            r#"{"type":"error","requestId":"other","message":"nope"}"#,
        ));
    }

    #[test]
    fn machine_parser_does_not_accept_human_or_agent_messages() {
        assert!(
            parse_machine_daemon_server_event(r#"{"type":"human_connected","user":{}}"#).is_none()
        );
        assert!(
            parse_machine_daemon_server_event(
                r#"{"type":"channel_message_received","channelId":"c1"}"#
            )
            .is_none()
        );
        assert!(
            parse_machine_daemon_server_event(r#"{"type":"agent_instance_connected","agent":{}}"#)
                .is_none()
        );
    }

    #[test]
    fn machine_runtime_reset_error_requires_a_fresh_reverse_delivery_socket() {
        assert!(durable_object_runtime_reset(
            "Durable Object reset because its code was updated."
        ));
        assert!(durable_object_runtime_reset(
            " durable object reset because its code was updated. "
        ));
        assert!(!durable_object_runtime_reset(
            "Machine Daemon report payload type mismatch"
        ));
    }

    #[test]
    fn machine_handshake_requires_a_positive_connection_epoch() {
        let daemon = r#"{
          "id":"daemon-1","userId":"user-1","name":"daemon","email":"u@example.com",
          "metadata":{},"connectedAt":"2026-08-04T00:00:00Z",
          "lastSeenAt":"2026-08-04T00:00:00Z","status":"online"
        }"#;
        let valid = format!(
            r#"{{"type":"machine_daemon_connected","daemon":{daemon},"connectionEpoch":7}}"#
        );
        let (_, epoch, activation) =
            parse_machine_daemon_connected(&valid).expect("valid daemon epoch");
        assert_eq!(epoch, 7);
        assert!(activation.is_none());
        let missing = format!(r#"{{"type":"machine_daemon_connected","daemon":{daemon}}}"#);
        assert!(parse_machine_daemon_connected(&missing).is_err());
        let zero = format!(
            r#"{{"type":"machine_daemon_connected","daemon":{daemon},"connectionEpoch":0}}"#
        );
        assert!(parse_machine_daemon_connected(&zero).is_err());
    }

    #[test]
    fn recovery_connect_and_receipt_bind_exact_transaction_evidence() {
        let mut client = MachineDaemonConnectionClient::new(
            "wss://example.test/ws/machine-daemons".into(),
            "token".into(),
            "Workstation".into(),
            "machine-1".into(),
            "host-1".into(),
            None,
            Vec::new(),
        );
        client.set_activation(MachineDaemonActivationConnect {
            mode: "recovering".into(),
            transaction_id: "tx-1".into(),
            transaction_nonce: "n".repeat(32),
            artifact_sha256: "a".repeat(64),
            source_connection_epoch: 7,
        });
        let connect = machine_daemon_connect_message("credential", &client.identity);
        assert_eq!(connect["hostname"], "host-1");
        assert!(connect.get("hostId").is_none());
        assert!(connect.get("hostName").is_none());
        assert_eq!(connect["activation"]["transactionId"], "tx-1");
        assert_eq!(connect["activation"]["sourceConnectionEpoch"], 7);

        let daemon = serde_json::json!({
            "id":"d","userId":"u","name":"n","email":"e","metadata":{},
            "connectedAt":"c","lastSeenAt":"l","status":"online"
        });
        let handshake = serde_json::json!({
            "type": "machine_daemon_connected",
            "daemon": daemon,
            "connectionEpoch": 8,
            "activation": {
                "type": "machine_activation_receipt",
                "requestId": "connect-1",
                "transactionId": "tx-1",
                "artifactSha256": "a".repeat(64),
                "connectionEpoch": 8,
                "phase": "recovering",
                "receiptId": "recovering:tx-1",
                "runSetDigest": "b".repeat(64),
                "expectedRunIds": ["run-1"]
            }
        });
        let (_, epoch, receipt) = parse_machine_daemon_connected(&handshake.to_string()).unwrap();
        assert_eq!(epoch, 8);
        let receipt = receipt.unwrap();
        assert_eq!(receipt.transaction_id, "tx-1");
        assert_eq!(receipt.expected_run_ids.unwrap(), vec!["run-1"]);
    }

    #[test]
    fn quota_probe_reverse_delivery_is_not_silently_dropped() {
        let event = parse_machine_daemon_server_event(
            &serde_json::json!({
                "type": "machine_quota_probe", "requestId": "quota:1",
                "probe": { "requestId": "quota:1", "connectionEpoch": 7,
                    "targets": [{"targetId": "registration:codex", "configurationDigest": "a".repeat(64)}] }
            })
            .to_string(),
        );
        let Some(MachineDaemonConnectionEvent::Command(MachineDaemonCommand::MachineQuotaProbe {
            request_id,
            probe,
            ..
        })) = event
        else {
            panic!("quota probe must reach command execution");
        };
        assert_eq!(request_id, "quota:1");
        assert_eq!(probe.connection_epoch, 7);
        assert_eq!(probe.targets[0].target_id, "registration:codex");
    }

    #[test]
    fn harness_action_reverse_delivery_is_not_silently_dropped() {
        let event = parse_machine_daemon_server_event(
            &serde_json::json!({
                "type": "machine_harness_action",
                "requestId": "harness:00000000-0000-4000-8000-000000000000",
                "presetId": "codex", "action": "auto_update_off"
            })
            .to_string(),
        );
        let Some(MachineDaemonConnectionEvent::Command(
            command @ MachineDaemonCommand::MachineHarnessAction { .. },
        )) = event
        else {
            panic!("harness action must reach command execution");
        };
        assert!(command.relay_lease().is_none());
        let MachineDaemonCommand::MachineHarnessAction {
            request_id,
            preset_id,
            action,
            ..
        } = command
        else {
            unreachable!()
        };
        assert_eq!(request_id, "harness:00000000-0000-4000-8000-000000000000");
        assert_eq!(preset_id, "codex");
        assert_eq!(action, HarnessAction::AutoUpdateOff);
        // An action outside the closed set is rejected, not guessed.
        let unknown = parse_machine_daemon_server_event(
            r#"{"type":"machine_harness_action","requestId":"r","presetId":"codex","action":"purge"}"#,
        );
        assert!(matches!(
            unknown,
            Some(MachineDaemonConnectionEvent::Error { .. })
        ));
        for action in [
            HarnessAction::Install,
            HarnessAction::Update,
            HarnessAction::Uninstall,
            HarnessAction::AutoUpdateOn,
            HarnessAction::AutoUpdateOff,
            HarnessAction::Refresh,
            HarnessAction::Release,
        ] {
            assert_eq!(HarnessAction::parse(action.as_str()), Some(action));
        }
        let report = serde_json::to_value(MachineDaemonReport::MachineHarnessActionResult {
            request_id: "harness:1".into(),
            result: HarnessActionResult {
                preset_id: "codex".into(),
                action: HarnessAction::Update,
                status: HarnessActionStatus::Succeeded,
                exit_code: Some(0),
                output_tail: None,
                item: None,
                inventory: None,
            },
            relay_lease: None,
        })
        .unwrap();
        assert_eq!(
            report,
            serde_json::json!({
                "type": "machine_harness_action_result", "requestId": "harness:1",
                "result": {"presetId": "codex", "action": "update", "status": "succeeded", "exitCode": 0}
            })
        );
    }

    #[test]
    fn reply_recovery_reverse_delivery_is_not_silently_dropped() {
        let event = parse_machine_daemon_server_event(
            r#"{"type":"machine_recover_reply","requestId":"recover:1",
              "runId":"run:1","instanceId":"instance:1","executionKey":"key:1",
              "channelId":"channel:1","executionId":"execution:1"}"#,
        );
        assert!(matches!(
            event,
            Some(MachineDaemonConnectionEvent::Command(
                MachineDaemonCommand::MachineRecoverReply { .. }
            ))
        ));
    }

    #[test]
    fn machine_stop_command_has_an_independent_wire_type() {
        let event = parse_machine_daemon_server_event(
            r#"{
              "type":"machine_stop_agent",
              "requestId":"stop-1",
              "runId":"run-1",
              "executionKey":"exec-1",
              "instanceId":"instance-1",
              "resumeSessionKey":"session-1",
              "repoIdentity":"github.com/lambdalabshq/xmatrix",
              "repoKeyId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "slotId":"cccccccccccccccccccccccccccccccc",
              "worktreeDisposition":"abandon",
              "pid":42,
              "reason":"owner request"
            }"#,
        );
        let Some(MachineDaemonConnectionEvent::Command(MachineDaemonCommand::MachineStopAgent {
            request_id,
            run_id,
            execution_key,
            instance_id,
            resume_session_key,
            repo_identity,
            repo_key_id,
            slot_id,
            worktree_disposition,
            pid,
            ..
        })) = event
        else {
            panic!("expected Machine Daemon stop command");
        };
        assert_eq!(request_id, "stop-1");
        assert_eq!(run_id.as_deref(), Some("run-1"));
        assert_eq!(execution_key.as_deref(), Some("exec-1"));
        assert_eq!(instance_id.as_deref(), Some("instance-1"));
        assert_eq!(resume_session_key.as_deref(), Some("session-1"));
        assert_eq!(
            repo_identity.as_deref(),
            Some("github.com/lambdalabshq/xmatrix")
        );
        assert_eq!(
            repo_key_id.as_deref(),
            Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        );
        assert_eq!(slot_id.as_deref(), Some("cccccccccccccccccccccccccccccccc"));
        assert_eq!(
            worktree_disposition.map(MachineWorktreeDisposition::as_str),
            Some("abandon")
        );
        assert_eq!(pid, Some(42));
    }

    #[test]
    fn machine_spawn_command_carries_the_summoning_message_when_the_hub_sends_one() {
        let spawn = |source: &str| {
            parse_machine_daemon_server_event(&format!(
                r#"{{
                  "type":"machine_spawn_agent",
                  "requestId":"spawn-1",
                  "spaceId":"space-1",
                  "workspace":{{
                    "ownerUserId":"user-1",
                    "machineId":"machine-1",
                    "hostId":"host-1",
                    "canonicalCwd":"C:/repo",
                    "displayName":"repo",
                    "runtimesSeen":[],
                    "boundChannelIds":[],
                    "visibility":"private",
                    "createdAt":"2026-01-01T00:00:00Z",
                    "updatedAt":"2026-01-01T00:00:00Z",
                    "lastSeenAt":"2026-01-01T00:00:00Z",
                    "metadata":{{}}
                  }},
                  "channelId":"channel-1",
                  "runtime":"codex",
                  "agentName":"codex",
                  {source}
                  "prompt":"investigate"
                }}"#
            ))
        };
        let Some(MachineDaemonConnectionEvent::Command(MachineDaemonCommand::MachineSpawnAgent {
            source_message_id,
            ..
        })) = spawn("\"sourceMessageId\":\"message-1\",")
        else {
            panic!("expected Machine Daemon spawn command");
        };
        assert_eq!(source_message_id.as_deref(), Some("message-1"));

        let Some(MachineDaemonConnectionEvent::Command(legacy_command)) = spawn("") else {
            panic!("expected legacy spawn command");
        };
        assert!(
            serde_json::to_value(legacy_command)
                .unwrap()
                .get("registration")
                .is_none(),
            "an upgrade must not change persisted legacy command fingerprints by adding a null binding"
        );

        // A hub that predates the field still spawns; the run simply has no
        // summoning message to acknowledge.
        let Some(MachineDaemonConnectionEvent::Command(MachineDaemonCommand::MachineSpawnAgent {
            source_message_id,
            ..
        })) = spawn("")
        else {
            panic!("expected Machine Daemon spawn command");
        };
        assert_eq!(source_message_id, None);
    }

    #[test]
    fn machine_spawn_command_parses_exact_repo_pool_resume_authority() {
        let event = parse_machine_daemon_server_event(
            r#"{
              "type":"machine_spawn_agent",
              "requestId":"spawn-1",
              "spaceId":"space-1",
              "runId":"run-2",
              "instanceId":"instance-1",
              "executionKey":"exec-2",
              "workspace":{
                "managedKey":"managed:repo",
                "ownerUserId":"user-1",
                "machineId":"machine-1",
                "hostId":"host-1",
                "canonicalCwd":"C:/repo",
                "displayName":"repo",
                "runtimesSeen":[],
                "boundChannelIds":[],
                "visibility":"private",
                "createdAt":"2026-01-01T00:00:00Z",
                "updatedAt":"2026-01-01T00:00:00Z",
                "lastSeenAt":"2026-01-01T00:00:00Z",
                "metadata":{}
              },
              "channelId":"channel-1",
              "runtime":"codex",
              "agentName":"codex",
              "resume":true,
              "resumeInstanceId":"instance-1",
              "resumeSessionKey":"session-1",
              "repoIdentity":"github.com/lambdalabshq/xmatrix",
              "repoKeyId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "slotId":"cccccccccccccccccccccccccccccccc",
              "runWorktree":true,
              "remoteRepo":"LambdaLabsHQ/xmatrix",
              "relayLease":{
                "leaseOwner":"machine:user:epoch:7",
                "leaseGeneration":1,
                "entityVersion":2,
                "daemonEpoch":7
              },
              "prompt":"continue"
            }"#,
        );
        let Some(MachineDaemonConnectionEvent::Command(MachineDaemonCommand::MachineSpawnAgent {
            repo_identity,
            repo_key_id,
            slot_id,
            relay_lease,
            ..
        })) = event
        else {
            panic!("expected Machine Daemon spawn command");
        };
        assert_eq!(
            repo_identity.as_deref(),
            Some("github.com/lambdalabshq/xmatrix")
        );
        assert_eq!(
            repo_key_id.as_deref(),
            Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        );
        assert_eq!(slot_id.as_deref(), Some("cccccccccccccccccccccccccccccccc"));
        assert_eq!(relay_lease.expect("lease").daemon_epoch, 7);
    }

    #[test]
    fn machine_spawn_command_ignores_retired_role_fields() {
        let event = parse_machine_daemon_server_event(
            r#"{
              "type":"machine_spawn_agent",
              "requestId":"spawn-3",
              "spaceId":"space-1",
              "runId":"run-4",
              "instanceId":"instance-3",
              "executionKey":"exec-4",
              "workspace":{
                "ownerUserId":"user-1",
                "machineId":"machine-1",
                "hostId":"host-1",
                "canonicalCwd":"C:/repo",
                "displayName":"repo",
                "runtimesSeen":[],
                "boundChannelIds":[],
                "visibility":"private",
                "createdAt":"2026-01-01T00:00:00Z",
                "updatedAt":"2026-01-01T00:00:00Z",
                "lastSeenAt":"2026-01-01T00:00:00Z",
                "metadata":{}
              },
              "channelId":"channel-1",
              "runtime":"codex",
              "agentName":"codex",
              "roleInitialPrompt":"Follow the registration instructions.",
              "roleReminder":"Stay within the reviewer role.",
              "roleSkills":[{
                "id":"skill:review",
                "name":"review",
                "version":"1.0.0",
                "digest":"sha256:abc",
                "description":"Review code",
                "skillMarkdown":"Review code carefully.",
                "source":"role"
              }],
              "roleAppRequirements":[{"providerId":"github","scopes":["repo"]}],
              "agentAvatarUrl":"https://example.com/role.png",
              "prompt":"continue"
            }"#,
        );
        let Some(MachineDaemonConnectionEvent::Command(command)) = event else {
            panic!("an older Hub's spawn with retired Role fields must still parse");
        };
        let MachineDaemonCommand::MachineSpawnAgent {
            ref request_id,
            ref role_initial_prompt,
            ..
        } = command
        else {
            panic!("expected Machine Daemon spawn command");
        };
        assert_eq!(request_id, "spawn-3");
        assert_eq!(
            role_initial_prompt.as_deref(),
            Some("Follow the registration instructions.")
        );
        let reserialized = serde_json::to_value(&command).expect("serialize spawn");
        for retired in [
            "roleReminder",
            "roleSkills",
            "roleAppRequirements",
            "agentAvatarUrl",
        ] {
            assert!(
                reserialized.get(retired).is_none(),
                "{retired} must be dropped"
            );
        }
    }

    #[test]
    fn machine_spawn_command_parses_handoff_transfer_fields() {
        let event = parse_machine_daemon_server_event(
            r#"{
              "type":"machine_spawn_agent",
              "requestId":"spawn-2",
              "spaceId":"space-1",
              "runId":"run-3",
              "instanceId":"instance-2",
              "executionKey":"exec-3",
              "workspace":{
                "ownerUserId":"user-1",
                "machineId":"machine-1",
                "hostId":"host-1",
                "canonicalCwd":"C:/repo",
                "displayName":"repo",
                "runtimesSeen":[],
                "boundChannelIds":[],
                "visibility":"private",
                "createdAt":"2026-01-01T00:00:00Z",
                "updatedAt":"2026-01-01T00:00:00Z",
                "lastSeenAt":"2026-01-01T00:00:00Z",
                "metadata":{}
              },
              "channelId":"channel-1",
              "runtime":"grok",
              "agentName":"grok",
              "resume":false,
              "resumeSessionKey":"session-new",
              "handoffTransfer":true,
              "handoffSourceInstanceId":"instance-1",
              "handoffSourceResumeSessionKey":"session-old",
              "repoIdentity":"github.com/lambdalabshq/xmatrix",
              "repoKeyId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "slotId":"cccccccccccccccccccccccccccccccc",
              "runWorktree":true,
              "remoteRepo":"LambdaLabsHQ/xmatrix",
              "prompt":"continue"
            }"#,
        );
        let Some(MachineDaemonConnectionEvent::Command(MachineDaemonCommand::MachineSpawnAgent {
            handoff_transfer,
            handoff_source_instance_id,
            handoff_source_resume_session_key,
            resume,
            ..
        })) = event
        else {
            panic!("expected Machine Daemon spawn command");
        };
        assert_eq!(handoff_transfer, Some(true));
        assert_eq!(handoff_source_instance_id.as_deref(), Some("instance-1"));
        assert_eq!(
            handoff_source_resume_session_key.as_deref(),
            Some("session-old")
        );
        assert_eq!(resume, Some(false));
    }

    #[test]
    fn machine_stop_result_echoes_exact_abandon_authority() {
        let report = MachineDaemonReport::MachineStopResult {
            request_id: "stop-1".to_string(),
            run_id: Some("run-1".to_string()),
            execution_key: Some("exec-1".to_string()),
            agent_id: Some("agent-1".to_string()),
            instance_id: Some("instance-1".to_string()),
            resume_session_key: Some("session-1".to_string()),
            repo_identity: Some("github.com/lambdalabshq/xmatrix".to_string()),
            repo_key_id: Some("a".repeat(64)),
            slot_id: Some("c".repeat(32)),
            worktree_disposition: Some(MachineWorktreeDisposition::Abandon),
            ok: true,
            pid: Some(42),
            cleanup_reason: Some("process_terminated".to_string()),
            error: None,
            handoff_export: None,
            relay_lease: None,
        };
        let value = serde_json::to_value(report).expect("serialize stop result");
        assert_eq!(value["type"], "machine_stop_result");
        assert_eq!(value["instanceId"], "instance-1");
        assert_eq!(value["resumeSessionKey"], "session-1");
        assert_eq!(value["worktreeDisposition"], "abandon");
        assert_eq!(value["cleanupReason"], "process_terminated");
        assert_eq!(value["slotId"], "c".repeat(32));
    }

    #[test]
    fn machine_stop_carries_a_handoff_export_both_ways() {
        let command: MachineDaemonCommand = serde_json::from_value(serde_json::json!({
            "type": "machine_stop_agent", "requestId": "stop-1", "runId": "run-1",
            "worktreeDisposition": "retain",
            "handoffExport": { "branch": "xmatrix/handoff/abc", "channelId": "channel-1" },
        }))
        .expect("parse stop with export");
        let MachineDaemonCommand::MachineStopAgent { handoff_export, .. } = command else {
            panic!("not a stop");
        };
        assert_eq!(
            handoff_export,
            Some(MachineHandoffExport {
                branch: "xmatrix/handoff/abc".to_string(),
                channel_id: "channel-1".to_string(),
            })
        );
        let report = MachineDaemonReport::MachineStopResult {
            request_id: "stop-1".to_string(),
            run_id: Some("run-1".to_string()),
            execution_key: None,
            agent_id: None,
            instance_id: None,
            resume_session_key: None,
            repo_identity: None,
            repo_key_id: None,
            slot_id: None,
            worktree_disposition: Some(MachineWorktreeDisposition::Retain),
            ok: true,
            pid: None,
            cleanup_reason: Some("process_terminated".to_string()),
            error: None,
            handoff_export: Some(MachineHandoffExportResult {
                branch: "xmatrix/handoff/abc".to_string(),
                state: "pushed".to_string(),
                commit: Some("c".repeat(40)),
                base: Some("b".repeat(40)),
                dirty: true,
                error: None,
            }),
            relay_lease: None,
        };
        let value = serde_json::to_value(report).expect("serialize stop result");
        assert_eq!(value["handoffExport"]["state"], "pushed");
        assert_eq!(value["handoffExport"]["dirty"], true);
        assert_eq!(value["handoffExport"]["commit"], "c".repeat(40));
    }

    #[test]
    fn machine_report_does_not_serialize_agent_or_human_envelopes() {
        let report = MachineDaemonReport::MachineRunSnapshot {
            request_id: None,
            snapshot_complete: Some(true),
            registry_connection_epoch: Some(7),
            registry_sequence: Some(11),
            captured_at: Some("2026-09-05T00:00:00Z".to_string()),
            machine_resources: None,
            harness_inventory: None,
            runs: Vec::new(),
        };
        let value = serde_json::to_value(report).expect("serialize machine report");
        assert_eq!(value["type"], "machine_run_snapshot");
        assert_eq!(value["registryConnectionEpoch"], 7);
        assert_eq!(value["registrySequence"], 11);
        assert!(value.get("agent").is_none());
        assert!(value.get("user").is_none());
        assert!(value.get("harnessInventory").is_none());
    }

    #[test]
    fn harness_observation_is_cached_offline_and_reconnect_preserves_other_metadata() {
        let client = MachineDaemonConnectionClient::new(
            "wss://example.test/ws".into(),
            "token".into(),
            "daemon".into(),
            "machine-1".into(),
            "host-1".into(),
            Some(serde_json::json!({"xmatrixCliVersion": "1", "hostname": "host"})),
            Vec::new(),
        );
        let observation = serde_json::json!({ "schemaVersion": 1,
            "capturedAt": "2026-09-30T12:00:00Z", "items": [],
        });
        client
            .report_harness_inventory(observation.clone())
            .unwrap();
        let connect = machine_daemon_connect_message("token", &client.identity);
        assert_eq!(connect["machineMetadata"]["harnesses"], observation);
        assert_eq!(connect["machineMetadata"]["xmatrixCliVersion"], "1");
        assert_eq!(connect["machineMetadata"]["hostname"], "host");
    }

    #[test]
    fn online_harness_report_is_partial_and_uses_the_authenticated_epoch() {
        let mut client = MachineDaemonConnectionClient::new(
            "wss://example.test/ws".into(),
            "token".into(),
            "daemon".into(),
            "machine-1".into(),
            "host-1".into(),
            None,
            Vec::new(),
        );
        let (tx, mut rx) = mpsc::unbounded_channel();
        client.instruction_tx = tx;
        client.connected.store(true, Ordering::Release);
        client.connection_epoch.store(7, Ordering::Release);
        let observation = serde_json::json!({"schemaVersion": 1,
            "capturedAt": "2026-09-30T12:00:00Z", "items": []});
        client
            .report_harness_inventory(observation.clone())
            .unwrap();
        let ConnectionInstruction::Report(report) = rx.try_recv().unwrap() else {
            panic!("expected report");
        };
        let value = serde_json::to_value(report).unwrap();
        assert_eq!(value["harnessInventory"], observation);
        assert_eq!(value["snapshotComplete"], false);
        assert_eq!(value["registryConnectionEpoch"], 7);
        assert_eq!(value["runs"], serde_json::json!([]));
    }

    #[test]
    fn registry_causality_is_stable_across_effect_replay() {
        let client = test_machine_daemon_client();
        client.connected.store(true, Ordering::Release);
        client.connection_epoch.store(7, Ordering::Release);
        let report = MachineDaemonReport::MachineRunSnapshot {
            request_id: None,
            snapshot_complete: Some(true),
            registry_connection_epoch: None,
            registry_sequence: None,
            captured_at: None,
            machine_resources: None,
            harness_inventory: None,
            runs: Vec::new(),
        };
        let first = client.bind_registry_causality(report).unwrap();
        let first_value = serde_json::to_value(&first).unwrap();
        let replay = client.bind_registry_causality(first).unwrap();
        let replay_value = serde_json::to_value(replay).unwrap();
        assert_eq!(first_value, replay_value);
        assert_eq!(first_value["registryConnectionEpoch"], 7);
        assert_eq!(first_value["registrySequence"], 1);

        let later = client
            .bind_registry_causality(MachineDaemonReport::MachineRunSnapshot {
                request_id: None,
                snapshot_complete: Some(true),
                registry_connection_epoch: None,
                registry_sequence: None,
                captured_at: None,
                machine_resources: None,
                harness_inventory: None,
                runs: Vec::new(),
            })
            .unwrap();
        assert_eq!(serde_json::to_value(later).unwrap()["registrySequence"], 2);
    }

    #[test]
    fn polled_spawn_result_uses_its_claim_epoch_while_socket_is_offline() {
        let client = test_machine_daemon_client();
        // A reconnect may advance the current epoch before an HTTP-polled
        // command finishes. The result must still carry the epoch that leased
        // its physical side effect, so Hub can reconcile or fence it exactly.
        client.connection_epoch.store(8, Ordering::Release);
        let report = MachineDaemonReport::MachineSpawnResult {
            request_id: "spawn-1".to_string(),
            launch_id: Some("launch-1".to_string()),
            run_id: Some("run-1".to_string()),
            execution_key: Some("exec-1".to_string()),
            instance_id: Some("instance-1".to_string()),
            machine_id: "machine-1".to_string(),
            canonical_cwd: "/workspace".to_string(),
            channel_id: "channel-1".to_string(),
            agent_name: "agent-1".to_string(),
            identity_id: Some("profile-1".to_string()),
            ok: true,
            spawned_at: Some("2026-09-05T00:00:00Z".to_string()),
            registry_connection_epoch: None,
            registry_sequence: None,
            pid: Some(42),
            error: None,
            metadata: None,
            relay_lease: Some(MachineDaemonCommandLease {
                lease_owner: "daemon-1".to_string(),
                lease_generation: 1,
                entity_version: 1,
                daemon_epoch: 7,
            }),
        };
        let first = client
            .bind_claimed_command_registry_causality(report)
            .expect("offline HTTP completion keeps the authenticated claim epoch");
        let first_value = serde_json::to_value(&first).unwrap();
        assert_eq!(first_value["registryConnectionEpoch"], 7);
        assert_eq!(first_value["registrySequence"], 1);
        let replay = client
            .bind_claimed_command_registry_causality(first)
            .expect("effect replay keeps the original causal tuple");
        assert_eq!(serde_json::to_value(replay).unwrap(), first_value);
    }

    #[test]
    fn transient_socket_outage_retains_the_authenticated_claim_epoch() {
        let client = test_machine_daemon_client();
        client.connected.store(true, Ordering::Release);
        client.connection_epoch.store(7, Ordering::Release);

        mark_machine_daemon_transport_offline(&client.connected);

        assert!(!client.is_connected());
        assert_eq!(client.connection_epoch(), None);
        assert_eq!(client.claim_connection_epoch(), Some(7));
        assert!(client.owns_connection_epoch(7));
        assert!(!client.owns_connection_epoch(6));
    }

    #[tokio::test]
    async fn offline_exact_epoch_lease_renewal_falls_back_without_socket_timeout() {
        let client = test_machine_daemon_client();
        client.connection_epoch.store(7, Ordering::Release);
        let lease = MachineDaemonCommandLease {
            lease_owner: "daemon-1".to_string(),
            lease_generation: 1,
            entity_version: 1,
            daemon_epoch: 7,
        };

        let error = client
            .renew_command_lease_over_socket("spawn-1", &lease)
            .await
            .unwrap_err();

        assert!(matches!(error, CliError::RelayTransient(message) if message.contains("offline")));
    }

    #[tokio::test(start_paused = true)]
    async fn a_silent_socket_admission_gives_up_inside_the_pushed_lease() {
        let mut client = MachineDaemonConnectionClient::new(
            "wss://example.test/ws".to_string(),
            "token".to_string(),
            "daemon".to_string(),
            "machine-1".to_string(),
            "host-1".to_string(),
            None,
            Vec::new(),
        );
        let (instruction_tx, mut instruction_rx) = mpsc::unbounded_channel();
        client.instruction_tx = instruction_tx;
        client.connected.store(true, Ordering::Release);
        client.connection_epoch.store(7, Ordering::Release);
        let report = MachineDaemonReport::MachineCommandAdmitted {
            request_id: "admit:stop-1".to_string(),
            control_id: "stop-1".to_string(),
            launch_id: None,
            channel_id: None,
            admitted_at: None,
            relay_lease: MachineDaemonCommandLease {
                lease_owner: "daemon-1".to_string(),
                lease_generation: 1,
                entity_version: 2,
                daemon_epoch: 7,
            },
        };

        let started = tokio::time::Instant::now();
        let error = client.admit_command(report).await.unwrap_err();
        // The writer task never answers; the caller must fall back to HTTP
        // while the Hub's ten-second lease is still live.
        assert!(started.elapsed() < Duration::from_secs(10));
        assert_eq!(started.elapsed(), COMMAND_ADMISSION_SOCKET_TIMEOUT);
        assert!(matches!(
            &error,
            CliError::RelayTransient(message) if message == "command admission timed out after 3s"
        ));
        assert!(matches!(
            instruction_rx.try_recv(),
            Ok(ConnectionInstruction::AdmitCommand { request_id, .. }) if request_id == "admit:stop-1"
        ));
    }

    #[test]
    fn approval_card_verdicts_reach_the_broker_and_other_errors_keep_their_correlation() {
        let accepted = parse_machine_daemon_server_event(
            r#"{"type":"machine_request_notice_accepted","requestId":"machine-request-notice:req:1:pending","channelId":"c","messageId":"m-1"}"#,
        );
        assert!(matches!(
            accepted,
            Some(MachineDaemonConnectionEvent::RequestNoticeDelivery { request_id, result: Ok(message_id) })
                if request_id == "machine-request-notice:req:1:pending" && message_id == "m-1"
        ));

        let rejected = parse_machine_daemon_server_event(
            r#"{"type":"error","requestId":"machine-request-notice:req:1:pending","message":"The Workstation request could not be processed. (code=runtime.authority_rejected, retryable=false, status=409)","failure":{"code":"runtime.authority_rejected","diagnosticId":"diag_1"}}"#,
        );
        assert!(matches!(
            rejected,
            Some(MachineDaemonConnectionEvent::RequestNoticeDelivery { result: Err(error), .. })
                if error.contains("status=409") && error.ends_with("(diagnosticId=diag_1)")
        ));

        let other = parse_machine_daemon_server_event(
            r#"{"type":"error","requestId":"report-7","message":"nope","failure":{"diagnosticId":"diag_2"}}"#,
        );
        assert!(matches!(
            other,
            Some(MachineDaemonConnectionEvent::Error { message, correlation: Some(correlation) })
                if message == "nope" && correlation == "requestId=report-7, diagnosticId=diag_2"
        ));

        // The runtime-reset check compares the bare message, so correlation
        // must never be folded into it.
        let reset = parse_machine_daemon_server_event(
            r#"{"type":"error","message":"Durable Object reset because its code was updated."}"#,
        );
        assert!(matches!(
            reset,
            Some(MachineDaemonConnectionEvent::Error { message, correlation: None })
                if crate::connection_error::durable_object_runtime_reset(&message)
        ));
    }
}
