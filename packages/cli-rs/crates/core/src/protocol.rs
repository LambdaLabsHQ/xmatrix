use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ── Constants ────────────────────────────────────────────────────────────────

pub const DEFAULT_HUB_URL: &str = "https://xmatrix-hub.xmatrix.sh";
pub const DEFAULT_WEB_URL: &str = "https://xmatrix.sh";
pub const TEST_HUB_URL: &str = "https://xmatrix-hub.test.xmatrix.sh";
pub struct HubRoutes;
impl HubRoutes {
    pub const LOGIN: &str = "/api/auth/cli/login";
    pub const DEVICE_START: &str = "/api/auth/cli/device/start";
    pub const SETUP_INTENTS: &str = "/api/setup-intents";
    pub const DEVICE_TOKEN: &str = "/api/auth/cli/device/token";
    pub const REFRESH: &str = "/api/auth/refresh";
    pub const EXCHANGE_SESSION: &str = "/api/auth/cli/exchange-session";
    pub const ME: &str = "/api/auth/me";
    pub const AGENT_INSTANCES: &str = "/api/agent-instances";
    pub const MACHINE_DAEMONS: &str = "/api/machine-daemons";
    pub const MACHINES: &str = "/api/machines";
    pub const MACHINE_DAEMON_CREDENTIALS: &str = "/api/machine-daemon-credentials";
    pub const MACHINE_DAEMON_MIGRATION_FENCE: &str = "/api/machine-daemon/migration-fence";
    pub const MACHINE_DAEMON_WORKSPACES: &str = "/api/machine-daemon/workspaces";
    pub const MACHINE_DAEMON_AGENT_RUN_TOKEN: &str = "/api/machine-daemon/agent-runs/token";
    pub const MACHINE_DAEMON_GITHUB_REPOSITORY_TOKEN: &str =
        "/api/machine-daemon/github/repository-token";
    #[allow(dead_code)]
    pub const SECRETS: &str = "/api/secrets";
    pub const RUN_SECRETS: &str = "/api/run-secrets";
    pub const CONNECTORS_MCP: &str = "/api/connectors/mcp";
    pub const SECRET_REQUESTS: &str = "/api/secret-requests";
    pub const DAEMON_CONTROL: &str = "/api/daemon/control";
    pub const DAEMON_COMMAND_LEASE_RENEW: &str = "/api/daemon/command-lease/renew";
    pub const DAEMON_COMMAND_ADMIT_AUTHORIZE: &str = "/api/daemon/command-admit-authorize";
    pub const DAEMON_CONTROL_RESULT: &str = "/api/daemon/control-result";
    #[allow(dead_code)]
    pub const AUTOMATIONS: &str = "/api/automations";
    pub const WORKSPACES: &str = "/api/workspaces";
    pub const STATUS: &str = "/api/status";
    pub const SPACES: &str = "/api/spaces";
    pub const CHANNELS: &str = "/api/channels";
    pub const MESSAGE_ATTACHMENT_PRODUCT_MEDIA: &str =
        "/api/relay-v2/message-attachments/product-media";
    pub const OBSERVABLE_CLIENT_METRICS: &str = "/api/observable/client-metrics";
    pub const MIGRATIONS_SLACK: &str = "/api/migrations/slack";
    pub const SLACK_OAUTH_START: &str = "/api/migrations/slack/oauth/start";
    pub const SLACK_OAUTH_TOKEN: &str = "/api/migrations/slack/oauth/token";
    pub const CROSS_SPACE_READ_REQUESTS: &str = "/api/cross-space-read/requests";
}

pub fn automation_route(automation_id: &str) -> String {
    format!("/api/automations/{}", urlencoding::encode(automation_id))
}

pub fn automation_cancel_execution_route(automation_id: &str) -> String {
    format!("{}/cancel-execution", automation_route(automation_id))
}

pub fn automation_pause_route(automation_id: &str) -> String {
    format!("{}/pause", automation_route(automation_id))
}

pub fn automation_resume_route(automation_id: &str) -> String {
    format!("{}/resume", automation_route(automation_id))
}

/// A Space's Agents: its registration catalog, one registration's details, and
/// the commands that change them.
pub fn space_agent_registrations_route(space_id: &str) -> String {
    format!(
        "/api/spaces/{}/agent-registrations",
        urlencoding::encode(space_id)
    )
}

pub fn space_agent_registration_query_route(space_id: &str) -> String {
    format!("{}/query", space_agent_registrations_route(space_id))
}

pub fn space_agent_registration_command_route(space_id: &str) -> String {
    format!("{}/commands", space_agent_registrations_route(space_id))
}

/// Cross-Space read grants (docs/cross-space-read-grants.md), addressed by the
/// target Space that holds them.
pub fn cross_space_read_grant_route(space_id: &str, grant_id: &str) -> String {
    format!(
        "/api/spaces/{}/cross-space-read-grants/{}",
        urlencoding::encode(space_id),
        urlencoding::encode(grant_id)
    )
}

pub fn cross_space_read_grant_decision_route(space_id: &str, grant_id: &str) -> String {
    format!(
        "{}/decision",
        cross_space_read_grant_route(space_id, grant_id)
    )
}

/// The pages a conversation is linked to, whole, for the Run's mirror.
pub fn channel_pages_route(channel_id: &str) -> String {
    format!("/api/channels/{}/pages", urlencoding::encode(channel_id))
}

pub fn space_secrets_route(space_id: &str) -> String {
    format!("/api/spaces/{}/secrets", urlencoding::encode(space_id))
}

pub fn space_secret_route(space_id: &str, secret_ref: &str) -> String {
    format!(
        "{}/{}",
        space_secrets_route(space_id),
        urlencoding::encode(secret_ref)
    )
}

// memory-fabric: per-channel annotations
pub fn channel_annotations_route(channel_id: &str) -> String {
    format!(
        "/api/channels/{}/annotations",
        urlencoding::encode(channel_id)
    )
}

pub fn channel_annotation_route(channel_id: &str, annotation_id: &str) -> String {
    format!(
        "/api/channels/{}/annotations/{}",
        urlencoding::encode(channel_id),
        urlencoding::encode(annotation_id)
    )
}

pub fn channel_worktree_route(channel_id: &str) -> String {
    format!("/api/channels/{}/worktree", urlencoding::encode(channel_id))
}

/// Hub-owned client compatibility policy. Mirrors
/// `packages/protocol/src/client-compatibility.ts`; the values behind it stay
/// on the Hub so an upgrade hint never has to be hard-coded into a release.
pub const CLIENT_COMPATIBILITY_PATH: &str = "/api/client-compatibility";

// ── Auth ──────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthUser {
    pub id: String,
    pub email: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthResponse {
    pub token: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub refresh_token: Option<String>,
    pub user: AuthUser,
    pub hub_url: String,
    pub relay_url: String,
}

// ── Serialized Models ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerializedAgent {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub instance_id: Option<String>,
    pub user_id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub agent_type: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub lifetime: Option<String>,
    pub email: String,
    pub metadata: serde_json::Value,
    pub connected_at: String,
    pub last_seen_at: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub avatar_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub runtime_state: Option<AgentRuntimeState>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub usage: Option<LlmUsage>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub instances: Option<Vec<SerializedAgentInstance>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct AutomationMessage {
    pub body: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub app_mentions: Option<Vec<serde_json::Value>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationCapabilities {
    pub update: bool,
    pub pause: bool,
    pub resume: bool,
    pub delete: bool,
    pub reason_required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationExecutionStatus {
    pub status: String,
    pub attempts: u64,
    pub scheduled_for: String,
    pub next_attempt_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub finished_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct SerializedAutomation {
    pub id: String,
    pub owner_user_id: String,
    #[serde(default)]
    pub version: u64,
    #[serde(default)]
    pub authority_root_user_id: String,
    #[serde(default)]
    pub capabilities: AutomationCapabilities,
    pub name: String,
    pub channel_id: String,
    #[serde(default)]
    pub can_manage: bool,
    pub message: AutomationMessage,
    pub interval_minutes: u64,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
    pub next_run_at: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub last_run_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub last_run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub last_run_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub last_run_finished_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub last_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub latest_execution: Option<AutomationExecutionStatus>,
    pub delivery_count: u64,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub last_delivery_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub last_message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub workspace: Option<WorkspaceRef>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub agent_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub execution_timeout_minutes: Option<u64>,
    pub run_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerializedAgentInstance {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub client_version: Option<String>,
    pub connected_at: String,
    pub last_seen_at: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub machine_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub host_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub host_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub workspace: Option<WorkspaceRef>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub workspace_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub git_branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub runtime_state: Option<AgentRuntimeState>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub capabilities: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub goal: Option<AgentGoalStatus>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub models: Option<Vec<AgentModelInfo>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub commands: Option<Vec<AgentInstanceCommand>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub parameters: Option<Vec<HarnessParameter>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub status_chips: Option<Vec<AgentStatusChip>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub usage: Option<LlmUsage>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HarnessParameter {
    pub id: String,
    pub label: String,
    pub options: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub kind: Option<HarnessParameterKind>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub choices: Option<Vec<HarnessParameterChoice>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub notice: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub alias_of: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub current_value: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HarnessParameterChoice {
    pub value: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum HarnessParameterKind {
    Boolean,
    Enum,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentInstanceCommand {
    pub token: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub argument_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub freeform: Option<bool>,
}

/// One tag the runtime declares about itself. Clients render what they are
/// given; time-varying facts travel as numbers (`percent`, `reset_at`) so the
/// client can format them fresh instead of showing a stale rendered string.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatusChip {
    pub id: String,
    pub label: String,
    /// Display value. Meter-only tags (quota windows, context) omit it.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub source: Option<String>,
    /// 0-100 fill for meter tags.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub percent: Option<f64>,
    /// Instant this window resets; the client formats it relative to now.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub reset_at: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentGoalStatus {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub active: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub objective: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub updated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub next_action: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub tokens_used: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub time_used_seconds: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub iteration_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub context_used: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub tool_call_count: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentModelReasoningEffort {
    pub reasoning_effort: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentModelInfo {
    pub id: String,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub hidden: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub is_default: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub default_reasoning_effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub supported_reasoning_efforts: Option<Vec<AgentModelReasoningEffort>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub input_modalities: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub supports_personality: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub upgrade: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeState {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub active_channel_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub active_message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub active_thread_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub active_turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub started_at_millis: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub updated_at_millis: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub execution: Option<AgentRuntimeExecutionEvidence>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub recent_executions: Vec<AgentRuntimeExecutionEvidence>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub waiting: Option<AgentRuntimeWaiting>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub issue: Option<AgentRuntimeIssue>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub notice: Option<AgentRuntimeNotice>,
}

/// A host-reported execution symptom shared by every harness. Raw diagnostics
/// remain in the host trace instead of being copied into public presence.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeIssue {
    pub kind: AgentRuntimeIssueKind,
    pub since_millis: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AgentRuntimeIssueKind {
    Retrying,
    Failed,
    Stalled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeNotice {
    pub severity: String,
    pub since_millis: u64,
}

/// What an Instance with work in hand is waiting on while its model produces
/// nothing (docs/design/agent-status.md). `kind` is `tool` (a tool call has run
/// past the threshold without returning) or `background` (the turn ended with
/// background tasks still running). `label` is what the harness says about the
/// call (its description, else its command, URL, query or tool name) or the
/// task count; `details` are the command under a described call, or each
/// background task's description.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeWaiting {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub details: Vec<String>,
    pub since_millis: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeMessageSource {
    pub channel_id: String,
    pub message_id: String,
    pub sequence: u64,
    pub entity_version: u64,
    pub body_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeExecutionEvidence {
    pub execution_id: String,
    pub revision: u64,
    pub source_count: u32,
    pub sources: Vec<AgentRuntimeMessageSource>,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub input_disposition: Option<String>,
    pub started_at_millis: u64,
    pub updated_at_millis: u64,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub finished_at_millis: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeExecutionSnapshot {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub execution: Option<AgentRuntimeExecutionEvidence>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub recent_executions: Vec<AgentRuntimeExecutionEvidence>,
}

/// Optional observation data must not break older lifecycle/status readers.
pub fn deserialize_optional_execution_snapshot<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<AgentRuntimeExecutionSnapshot>, D::Error> {
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(serde_json::from_value(value).ok())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRef {
    pub machine_id: String,
    pub canonical_cwd: String,
}

/// Shared registered/spawn location fields. Wire keys remain flattened; each
/// containing record retains its own defaults for runtime and channel arrays.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceLocation {
    pub owner_user_id: String,
    pub machine_id: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub hostname: Option<String>,
    pub canonical_cwd: String,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub repo_root: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub git_remote: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub git_branch: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerializedWorkspace {
    #[serde(flatten)]
    pub location: WorkspaceLocation,
    pub runtimes_seen: Vec<String>,
    pub bound_channel_ids: Vec<String>,
    pub visibility: String,
    pub created_at: String,
    pub updated_at: String,
    pub last_seen_at: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub metadata: Option<serde_json::Value>,
}

/// Daemon spawn location. Registered directories use machine_id +
/// canonical_cwd as their natural identity; managed_key names a daemon-local
/// managed directory. No opaque workspace id crosses the spawn boundary.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonSpawnWorkspace {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub managed_key: Option<String>,
    #[serde(flatten)]
    pub location: WorkspaceLocation,
    #[serde(default)]
    pub runtimes_seen: Vec<String>,
    #[serde(default)]
    pub bound_channel_ids: Vec<String>,
    pub visibility: String,
    pub created_at: String,
    pub updated_at: String,
    pub last_seen_at: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageSender {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub identity_id: Option<String>,
    /// Serialized sender role: `user`, `agent`, or `app`.
    pub kind: String,
    pub label: String,
    pub user_id: String,
    pub email: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub agent_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub instance_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub instance_label: Option<String>,
    /// The Channel an Agent Run belongs to, set only when it wrote outside it
    /// (a cross-Channel link). `label` and `instance_label` are ordinals there.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub origin_channel_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub goal: Option<AgentGoalStatus>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub workspace: Option<WorkspaceRef>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub workspace_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub avatar_url: Option<String>,
}

/// Where a relayed reply to a cross-Channel link was written. The Hub relays
/// the reply into the link's Channel under the link owner's authority and
/// records the answered Channel and message in metadata; an Agent answers back
/// there with `--reply-to` the source message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CrossChannelReplySource {
    pub channel_id: String,
    pub message_id: Option<String>,
    /// `user` or `agent`: who answered, since the relay's own author is the
    /// link owner.
    pub replier_kind: Option<String>,
    /// The exact Instance that wrote the reply, when an Agent answered.
    pub replier_instance_id: Option<String>,
}

pub fn cross_channel_reply_source(
    metadata: Option<&serde_json::Value>,
) -> Option<CrossChannelReplySource> {
    let metadata = metadata?;
    if metadata.get("xmatrixProvenance")?.as_str()? != "cross_channel_reply" {
        return None;
    }
    let relayed = metadata.get("crossChannelReply")?;
    let text = |key: &str| {
        relayed
            .get(key)
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    let replier_kind = text("replierKind").filter(|kind| kind == "user" || kind == "agent");
    let replier_instance_id =
        text("replierInstanceId").filter(|_| replier_kind.as_deref() == Some("agent"));
    Some(CrossChannelReplySource {
        channel_id: text("sourceChannelId")?,
        message_id: text("sourceMessageId"),
        replier_kind,
        replier_instance_id,
    })
}

impl CrossChannelReplySource {
    /// The header suffix naming where the reply was written and how to answer.
    pub fn header_context(&self) -> String {
        match &self.message_id {
            Some(message_id) => format!(
                " replying in Channel {channel} to a cross-Channel request from this Channel (answer there with `xmatrix send {channel} --reply-to {message_id}`)",
                channel = self.channel_id
            ),
            None => format!(
                " replying in Channel {} to a cross-Channel request from this Channel",
                self.channel_id
            ),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelMessage {
    pub message_id: String,
    pub channel_id: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub sequence: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub entity_version: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub body_hash: Option<String>,
    pub from: MessageSender,
    pub body: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub reply_to_message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub reply_to: Option<ChannelReplyContext>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub attachments: Option<Vec<ChannelAttachment>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub app_mentions: Option<Vec<ChannelAppMention>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub metadata: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub mention_read_statuses: Option<Vec<ChannelMentionReadStatus>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub reactions: Option<Vec<ChannelReaction>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub edited_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub edited_by: Option<MessageSender>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub recalled_at: Option<String>,
    /// A permanent-deletion tombstone, without payload or task-source evidence.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub deleted_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub recalled_by: Option<MessageSender>,
    /// The later message from the same sender that the Hub judged makes this
    /// one obsolete (docs/design/conversation-activity.md §3.3).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub superseded_by: Option<String>,
    pub sent_at: String,
}

/// Metadata provenance of an activity entry (docs/design/conversation-activity.md).
pub const CHANNEL_ACTIVITY_PROVENANCE: &str = "activity";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ChannelActivityPlanStepStatus {
    Pending,
    InProgress,
    Completed,
}

/// One step of the reporting Run's own plan.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChannelActivityPlanStep {
    pub text: String,
    pub status: ChannelActivityPlanStepStatus,
}

/// A fact a Run's runtime observed about its own work, reported with
/// `channel_activity` and kept in the timeline as a compact entry.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ChannelActivity {
    Plan {
        /// Steps completed since the previous plan entry, oldest first.
        completed: Vec<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        in_progress: Option<String>,
        steps: Vec<ChannelActivityPlanStep>,
    },
    PullRequest {
        url: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        repository: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        number: Option<u64>,
    },
}

/// The activity an activity entry carries, from its metadata.
pub fn channel_activity_of(metadata: Option<&serde_json::Value>) -> Option<ChannelActivity> {
    let metadata = metadata?;
    if metadata.get("xmatrixProvenance")?.as_str()? != CHANNEL_ACTIVITY_PROVENANCE {
        return None;
    }
    serde_json::from_value(metadata.get("xmatrixActivity")?.clone()).ok()
}

/// How history prints an entry nobody needs to read in full
/// (docs/design/conversation-activity.md §4.3): an activity entry as its line,
/// a superseded report as its first line and what superseded it. Order and the
/// message id stay on the entry, so it can still be quoted or replied to.
pub fn folded_history_line(message: &ChannelMessage) -> Option<String> {
    if message.recalled_at.is_some() {
        return None;
    }
    if let Some(activity) = channel_activity_of(message.metadata.as_ref()) {
        return Some(format!("▸ {}", channel_activity_line(&activity)));
    }
    let by = message
        .superseded_by
        .as_deref()
        .filter(|id| !id.trim().is_empty())?;
    let mut lines = message
        .body
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty());
    let first = lines.next().unwrap_or_default();
    let mut line: String = first.chars().take(160).collect();
    if first.chars().count() > 160 || lines.next().is_some() {
        line.push('…');
    }
    Some(format!("[superseded by {by}] {line}"))
}

/// One plain line for an activity entry, the same glyphs the web shows.
pub fn channel_activity_line(activity: &ChannelActivity) -> String {
    match activity {
        ChannelActivity::PullRequest {
            url,
            repository,
            number,
        } => match (repository, number) {
            (Some(repository), Some(number)) => {
                format!("↗ Opened pull request {repository}#{number}")
            }
            _ => format!("↗ Opened pull request {url}"),
        },
        ChannelActivity::Plan {
            completed,
            in_progress,
            steps,
        } => {
            let parts: Vec<String> = completed
                .iter()
                .map(|step| format!("✓ {step}"))
                .chain(in_progress.iter().map(|step| format!("→ {step}")))
                .collect();
            if parts.is_empty() {
                format!(
                    "Plan: {} step{}",
                    steps.len(),
                    if steps.len() == 1 { "" } else { "s" }
                )
            } else {
                parts.join(" · ")
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelAppMention {
    pub token: String,
    pub app_id: String,
    pub app_name: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub action_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub action_label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelMentionReadStatus {
    pub target_id: String,
    pub target_kind: String,
    pub label: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub read_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub read_sequence: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelReactionActor {
    pub identity_id: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelReaction {
    pub emoji: String,
    pub reactors: Vec<ChannelReactionActor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelReplyContext {
    pub message_id: String,
    pub from: MessageSender,
    pub body_preview: String,
    pub sent_at: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub recalled_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelAttachment {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub mime_type: String,
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub channel_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub message_id: Option<String>,
    #[serde(default)]
    pub data_url: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchRecipient {
    pub id: String,
    pub name: String,
    pub online: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceMember {
    pub user_id: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub name: Option<String>,
    pub role: String,
    pub joined_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerializedSpace {
    pub id: String,
    pub name: String,
    pub owner_id: String,
    pub members: Vec<SpaceMember>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub metadata: Option<serde_json::Value>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerializedChannel {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub space_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub topic: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub summary: Option<String>,
    /// Who wrote `summary`, when, and how far into the conversation it reaches.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub summary_source: Option<ChannelSummarySource>,
    pub mode: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub message_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub member_presence: Option<HashMap<String, ChannelMemberPresence>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub metadata: Option<serde_json::Value>,
    pub created_by: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub created_by_agent: Option<SerializedChannelCreatorAgent>,
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelSummarySource {
    pub author: ChannelSummaryAuthor,
    pub generated_at: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub through_sequence: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelSummaryAuthor {
    pub kind: String,
    pub run_id: String,
    pub agent_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerializedChannelCreatorAgent {
    pub identity_id: String,
    pub agent_name: String,
    pub user_id: String,
    pub email: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub instance_id: Option<String>,
}

// memory-fabric: annotation types
// Generic "target × namespace × opaque payload" record on a channel.
// Hub never parses payload.

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationTarget {
    pub kind: String, // "channel" | "message" | "message_range"
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub start_sequence: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub end_sequence: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerializedAnnotation {
    pub id: String,
    /// Absent on the PostgreSQL authority, which answers for one Channel.
    #[serde(default)]
    pub channel_id: String,
    pub namespace: String,
    pub target: AnnotationTarget,
    pub payload: serde_json::Value,
    #[serde(alias = "authorUserId", default)]
    pub author: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub author_label: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAnnotationRequest {
    pub namespace: String,
    pub target: AnnotationTarget,
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationEnvelope {
    pub annotation: SerializedAnnotation,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListAnnotationsResponse {
    pub annotations: Vec<SerializedAnnotation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelMemberPresence {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub focused: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub avatar_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub last_seen_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub activity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub files: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub intent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub runtime_state: Option<AgentRuntimeState>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub usage: Option<LlmUsage>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub instances: Option<Vec<SerializedAgentInstance>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLifecycleSnapshot {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub presence: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub run: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub process: Option<String>,
}

// ── Client → Hub Messages ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInstanceRuntimeIdentity {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub client_version: Option<String>,
    pub protocol_version: u32,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub capabilities: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInstanceConnectMessage {
    #[serde(rename = "type")]
    pub message_type: &'static str,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub request_id: Option<String>,
    pub token: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub identity_id: Option<String>,
    pub name: String,
    pub runtime: AgentInstanceRuntimeIdentity,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub run_context: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AgentInstanceClientMessage {
    Ping {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        request_id: Option<String>,
    },
    RefreshAuth {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        request_id: Option<String>,
        token: String,
    },
    Unregister {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        request_id: Option<String>,
    },
    JoinChannel {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        request_id: Option<String>,
        channel_id: String,
        history_limit: u32,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        after_sequence: Option<u64>,
    },
    ReplayChannelHistory {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        request_id: Option<String>,
        channel_id: String,
        history_limit: u32,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        after_sequence: Option<u64>,
    },
    LeaveChannel {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        request_id: Option<String>,
        channel_id: String,
    },
    GetChannelHistory {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        request_id: Option<String>,
        channel_id: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        limit: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        before: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        after_sequence: Option<u64>,
    },
    ChannelMessage {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        request_id: Option<String>,
        channel_id: String,
        body: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        reply_to_message_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        app_mentions: Option<Vec<ChannelAppMention>>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        metadata: Option<serde_json::Value>,
    },
    /// A fact this Run's runtime observed about its own work. The Hub writes
    /// the entry and delivers it as context, never as work.
    ChannelActivity {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        request_id: Option<String>,
        channel_id: String,
        activity: ChannelActivity,
    },
    ChannelMessageAck {
        message_id: String,
        channel_id: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        sequence: Option<u64>,
    },
    PresenceUpdate {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        request_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        status: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        activity: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        files: Option<Vec<String>>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        intent: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        git_branch: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        capabilities: Option<Vec<String>>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        runtime_state: Option<Box<AgentRuntimeState>>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        goal: Option<Option<AgentGoalStatus>>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        model: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        models: Option<Vec<AgentModelInfo>>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        effort: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        commands: Option<Vec<AgentInstanceCommand>>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        parameters: Option<Vec<HarnessParameter>>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        status_chips: Option<Vec<AgentStatusChip>>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        usage: Option<Box<LlmUsage>>,
    },
    AgentModelSwitchResult {
        request_id: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        model: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        error: Option<String>,
    },
    AgentEffortSwitchResult {
        request_id: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        effort: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        error: Option<String>,
    },
    AgentLifecycle {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        request_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        channel_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        agent_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        instance_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        agent_name: Option<String>,
        layer: String,
        status: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        reason: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        detail: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        snapshot: Option<AgentLifecycleSnapshot>,
        /// RFC 3339 time a `usage_limited` provider account resets, when known.
        #[serde(skip_serializing_if = "Option::is_none", default)]
        resets_at: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        ts: Option<String>,
    },
    ClientNetworkSample {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        request_id: Option<String>,
        client_kind: String,
        mode: String,
        network_state: String,
        result: String,
        channel_id: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        latency_ms: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        entry_count: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        truncated: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        after_sequence: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        last_sequence: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        reconnect_attempt: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        last_server_activity_age_ms: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        reason: Option<String>,
    },
    EventPublish {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        request_id: Option<String>,
        channel_id: String,
        event_type: String,
        payload: serde_json::Value,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        event_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        timestamp: Option<String>,
    },
    TraceHistoryResult {
        request_id: String,
        instance_id: String,
        availability: String,
        complete: bool,
        events: Vec<crate::agent_trace_store::AgentHostTraceEvent>,
        /// Always serialized (null on the oldest page): its presence tells Hub
        /// this host pages, so a `before` read is never answered with the
        /// newest page by a host that ignored the cursor.
        #[serde(default)]
        next_cursor: Option<String>,
    },
}

/// Usage wire types are owned by the independently publishable
/// `xmatrix-harness` crate; this re-export keeps every `protocol::` path and
/// the serialized shape unchanged.
pub use xmatrix_harness::usage::{LlmQuotaAccount, LlmQuotaCredits, LlmQuotaUsage, LlmUsage};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmTraceAgent {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub instance_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub channel_instance_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub runtime_instance_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub name: Option<String>,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none", default)]
    pub agent_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmTracePayload {
    pub schema_version: u8,
    pub phase: String,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub agent: Option<LlmTraceAgent>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub usage: Option<LlmUsage>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub payload: Option<serde_json::Value>,
}

// ── Hub → Client Messages ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentOperationFailure {
    pub code: String,
    pub diagnostic_id: String,
    pub retryable: bool,
    pub stage: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub origin_stage: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AgentInstanceServerMessage {
    Error {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        request_id: Option<String>,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        failure: Option<AgentOperationFailure>,
    },
    AgentInstanceConnected {
        agent: SerializedAgent,
        peers: Vec<SerializedAgent>,
        /// Client frame types this Hub accepts beyond the original set. A Hub
        /// closes the socket on a type it does not know, so a newer type is
        /// sent only when listed here.
        #[serde(skip_serializing_if = "Option::is_none", default)]
        hub_capabilities: Option<Vec<String>>,
    },
    Presence {
        online: bool,
        agent: SerializedAgent,
    },
    AgentLifecycle {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        channel_id: Option<String>,
        agent_id: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        instance_id: Option<String>,
        agent_name: String,
        layer: String,
        status: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        reason: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        detail: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        snapshot: Option<AgentLifecycleSnapshot>,
        ts: String,
    },
    Pong {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        request_id: Option<String>,
        ts: String,
    },
    AuthRefreshed {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        request_id: Option<String>,
        ts: String,
    },
    Unregistered {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        request_id: Option<String>,
    },
    ShutdownRequested {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        reason: Option<String>,
    },
    TraceHistoryRequested {
        request_id: String,
        instance_id: String,
        max_events: u32,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        since: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        before: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        max_bytes: Option<u32>,
        /// A `since` read may wait up to this long for a newer event.
        #[serde(skip_serializing_if = "Option::is_none", default)]
        wait_ms: Option<u32>,
    },
    AgentModelSwitchRequested {
        request_id: String,
        model: String,
    },
    AgentEffortSwitchRequested {
        request_id: String,
        effort: String,
    },
    ChannelJoined {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        request_id: Option<String>,
        channel_id: String,
        agent: SerializedAgent,
    },
    ChannelLeft {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        request_id: Option<String>,
        channel_id: String,
        agent: SerializedAgent,
    },
    /// One committed message plus transport facts. The message is nested and
    /// carried verbatim, so a delivery cannot describe a different message than
    /// history does; only the fields around it are transport.
    ChannelMessageReceived {
        message: ChannelMessage,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        client_message_id: Option<String>,
        #[serde(default)]
        ack_required: Option<bool>,
        #[serde(default)]
        interrupt_requested: Option<bool>,
        /// Work or orientation. Absent means work: a hub that predates the
        /// field must never have its deliveries silently dropped.
        #[serde(skip_serializing_if = "Option::is_none", default)]
        delivery_intent: Option<String>,
    },
    ChannelHistoryReplay {
        message: ChannelMessage,
        #[serde(default)]
        ack_required: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        delivery_intent: Option<String>,
    },
    ChannelMessageUpdated {
        channel_id: String,
        message: ChannelMessage,
    },
    ChannelHistory {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        request_id: Option<String>,
        channel_id: String,
        messages: Vec<ChannelMessage>,
    },
    ChannelMessageDispatched {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        request_id: Option<String>,
        message_id: String,
        channel_id: String,
        recipients: Vec<DispatchRecipient>,
    },
    ChannelMessageUndelivered {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        request_id: Option<String>,
        message_id: String,
        channel_id: String,
        recipient_id: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        recipient_name: Option<String>,
    },
}

// ── URL Utilities ────────────────────────────────────────────────────────────

pub fn normalize_hub_url(input: Option<&str>) -> String {
    let value = input
        .unwrap_or(DEFAULT_HUB_URL)
        .trim()
        .trim_end_matches('/');

    if let Some(rest) = value.strip_prefix("ws://") {
        return format!("http://{}", rest.trim_end_matches("/ws"));
    }
    if let Some(rest) = value.strip_prefix("wss://") {
        return format!("https://{}", rest.trim_end_matches("/ws"));
    }

    value.trim_end_matches("/ws").to_string()
}

pub fn with_route(base_url: &str, route: &str) -> String {
    let base = normalize_hub_url(Some(base_url));
    format!("{}{}", base.trim_end_matches('/'), route)
}

// ── Tests ────────────────────────────────────────────────────────────────────

/// The stable history order, including messages without an assigned sequence.
pub fn compare_channel_messages(
    left: &ChannelMessage,
    right: &ChannelMessage,
) -> std::cmp::Ordering {
    left.sequence
        .cmp(&right.sequence)
        .then_with(|| left.sent_at.cmp(&right.sent_at))
        .then_with(|| left.message_id.cmp(&right.message_id))
}

impl std::ops::Deref for SerializedWorkspace {
    type Target = WorkspaceLocation;
    fn deref(&self) -> &Self::Target {
        &self.location
    }
}

impl std::ops::Deref for DaemonSpawnWorkspace {
    type Target = WorkspaceLocation;
    fn deref(&self) -> &Self::Target {
        &self.location
    }
}

impl std::ops::DerefMut for SerializedWorkspace {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.location
    }
}

impl std::ops::DerefMut for DaemonSpawnWorkspace {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.location
    }
}

impl AgentOperationFailure {
    pub fn is_valid_observation(&self) -> bool {
        fn identifier(value: &str) -> bool {
            !value.is_empty()
                && value.len() <= 80
                && value.as_bytes()[0].is_ascii_lowercase()
                && value.bytes().all(|byte| {
                    byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"_.-".contains(&byte)
                })
        }
        identifier(&self.code)
            && identifier(&self.stage)
            && self.origin_stage.as_deref().is_none_or(identifier)
            && self.diagnostic_id.strip_prefix("diag_").is_some_and(|id| {
                id.len() == 36
                    && id.bytes().all(|byte| {
                        byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte) || byte == b'-'
                    })
                    && uuid::Uuid::parse_str(id).is_ok()
            })
    }
}
pub fn deserialize_optional_operation_failure<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<AgentOperationFailure>, D::Error> {
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(serde_json::from_value::<AgentOperationFailure>(value)
        .ok()
        .filter(AgentOperationFailure::is_valid_observation))
}

pub fn deserialize_optional_message_source<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<AgentRuntimeMessageSource>, D::Error> {
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(serde_json::from_value::<AgentRuntimeMessageSource>(value)
        .ok()
        .filter(|source| {
            let id = |value: &str| {
                !value.is_empty()
                    && value.len() <= 300
                    && value.trim() == value
                    && !value.chars().any(char::is_control)
            };
            id(&source.channel_id)
                && id(&source.message_id)
                && source.sequence > 0
                && source.entity_version > 0
                && source.sequence <= 9_007_199_254_740_991
                && source.entity_version <= 9_007_199_254_740_991
                && source.body_hash.len() == 64
                && source
                    .body_hash
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_location_stays_flat_and_spawn_array_defaults_remain_distinct() {
        let value = serde_json::json!({
            "ownerUserId": "owner", "machineId": "machine", "canonicalCwd": "/workspace",
            "displayName": "workspace", "visibility": "private", "createdAt": "1", "updatedAt": "2", "lastSeenAt": "3"
        });
        let spawn: DaemonSpawnWorkspace = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(spawn.owner_user_id, "owner");
        assert!(spawn.runtimes_seen.is_empty());
        assert!(spawn.bound_channel_ids.is_empty());
        let mut expected = value;
        expected["runtimesSeen"] = serde_json::json!([]);
        expected["boundChannelIds"] = serde_json::json!([]);
        assert_eq!(serde_json::to_value(&spawn).unwrap(), expected);
        let registered: SerializedWorkspace = serde_json::from_value(expected.clone()).unwrap();
        assert_eq!(serde_json::to_value(registered).unwrap(), expected);
        for field in [
            "runtimesSeen",
            "boundChannelIds",
            "ownerUserId",
            "machineId",
            "canonicalCwd",
        ] {
            let mut incomplete = expected.clone();
            incomplete.as_object_mut().unwrap().remove(field);
            assert!(
                serde_json::from_value::<SerializedWorkspace>(incomplete).is_err(),
                "{field}"
            );
        }
    }

    fn history_entry(value: serde_json::Value) -> ChannelMessage {
        let mut message = serde_json::json!({
            "messageId": "m-1", "channelId": "c-1", "sequence": 3,
            "from": { "kind": "agent", "label": "claude:1", "userId": "owner", "email": "" },
            "body": "Progress: running the e2e regression.\nThen PR 2.",
            "sentAt": "2026-09-27T18:27:00Z",
        });
        for (key, field) in value.as_object().unwrap() {
            message[key] = field.clone();
        }
        serde_json::from_value(message).unwrap()
    }

    #[test]
    fn activity_and_superseded_reports_fold_to_one_history_line() {
        let activity = history_entry(serde_json::json!({
            "body": "✓ Run e2e · → Open PR 2",
            "metadata": { "xmatrixProvenance": "activity", "xmatrixActivity": {
                "kind": "plan", "completed": ["Run e2e"], "inProgress": "Open PR 2",
                "steps": [{ "text": "Run e2e", "status": "completed" },
                    { "text": "Open PR 2", "status": "in_progress" }] } },
        }));
        assert_eq!(
            folded_history_line(&activity).as_deref(),
            Some("▸ ✓ Run e2e · → Open PR 2")
        );
        let pull_request = history_entry(serde_json::json!({
            "metadata": { "xmatrixProvenance": "activity", "xmatrixActivity": {
                "kind": "pull_request", "repository": "LambdaLabsHQ/xmatrix", "number": 3043,
                "url": "https://github.com/LambdaLabsHQ/xmatrix/pull/3043" } },
        }));
        assert_eq!(
            folded_history_line(&pull_request).as_deref(),
            Some("▸ ↗ Opened pull request LambdaLabsHQ/xmatrix#3043")
        );
        let superseded = history_entry(serde_json::json!({ "supersededBy": "m-9" }));
        assert_eq!(
            folded_history_line(&superseded).as_deref(),
            Some("[superseded by m-9] Progress: running the e2e regression.…")
        );
        assert_eq!(
            folded_history_line(&history_entry(serde_json::json!({}))),
            None
        );
        assert_eq!(
            folded_history_line(&history_entry(serde_json::json!({ "supersededBy": " " }))),
            None
        );
        let recalled = history_entry(serde_json::json!({
            "recalledAt": "2026-09-27T18:30:00Z",
            "metadata": { "xmatrixProvenance": "activity",
                "xmatrixActivity": { "kind": "plan", "completed": ["x"], "steps": [] } },
        }));
        assert_eq!(folded_history_line(&recalled), None);
        let deleted = history_entry(serde_json::json!({
            "deletedAt": "2026-10-02T00:00:00Z", "body": "",
        }));
        assert_eq!(deleted.deleted_at.as_deref(), Some("2026-10-02T00:00:00Z"));
        let encoded = serde_json::to_value(&deleted).unwrap();
        assert_eq!(encoded["deletedAt"], "2026-10-02T00:00:00Z");
    }

    #[test]
    fn a_channel_activity_report_serializes_as_the_hub_expects() {
        let message = AgentInstanceClientMessage::ChannelActivity {
            request_id: Some("r-1".into()),
            channel_id: "c-1".into(),
            activity: ChannelActivity::Plan {
                completed: vec!["a".into()],
                in_progress: Some("b".into()),
                steps: vec![ChannelActivityPlanStep {
                    text: "b".into(),
                    status: ChannelActivityPlanStepStatus::InProgress,
                }],
            },
        };
        assert_eq!(
            serde_json::to_value(&message).unwrap(),
            serde_json::json!({
                "type": "channel_activity", "requestId": "r-1", "channelId": "c-1",
                "activity": { "kind": "plan", "completed": ["a"], "inProgress": "b",
                    "steps": [{ "text": "b", "status": "in_progress" }] },
            })
        );
        let pull_request = serde_json::to_value(ChannelActivity::PullRequest {
            url: "https://github.com/a/b/pull/1".into(),
            repository: None,
            number: None,
        })
        .unwrap();
        assert_eq!(
            pull_request,
            serde_json::json!({ "kind": "pull_request", "url": "https://github.com/a/b/pull/1" })
        );
    }

    #[test]
    fn agent_instance_client_protocol_rejects_profile_and_administration_messages() {
        for message in [
            r#"{"type":"register","token":"human-token","name":"profile"}"#,
            r#"{"type":"list_agents"}"#,
            r#"{"type":"rename_agent","name":"other"}"#,
            r#"{"type":"create_channel","mode":"open","access":[]}"#,
            r#"{"type":"delete_channel","channelId":"channel-1"}"#,
            r#"{"type":"list_channels"}"#,
        ] {
            assert!(
                serde_json::from_str::<AgentInstanceClientMessage>(message).is_err(),
                "retired Agent Instance message unexpectedly decoded: {message}"
            );
        }
    }

    #[test]
    fn client_message_ping_wire_format() {
        let msg = AgentInstanceClientMessage::Ping {
            request_id: Some("p1".into()),
        };
        let json = serde_json::to_value(&msg).unwrap();
        assert_eq!(json["type"], "ping");
        assert_eq!(json["requestId"], "p1");
    }

    #[test]
    fn client_message_client_network_sample_wire_format() {
        let msg = AgentInstanceClientMessage::ClientNetworkSample {
            request_id: Some("sample-1".into()),
            client_kind: "cli".into(),
            mode: "reconnect".into(),
            network_state: "online".into(),
            result: "success".into(),
            channel_id: "ch-1".into(),
            latency_ms: Some(1250),
            entry_count: Some(2),
            truncated: Some(false),
            after_sequence: Some(7),
            last_sequence: Some(9),
            reconnect_attempt: Some(3),
            last_server_activity_age_ms: Some(75_000),
            reason: Some("heartbeat_timeout".into()),
        };

        let json = serde_json::to_value(&msg).unwrap();
        assert_eq!(json["type"], "client_network_sample");
        assert_eq!(json["requestId"], "sample-1");
        assert_eq!(json["clientKind"], "cli");
        assert_eq!(json["mode"], "reconnect");
        assert_eq!(json["networkState"], "online");
        assert_eq!(json["result"], "success");
        assert_eq!(json["channelId"], "ch-1");
        assert_eq!(json["latencyMs"], 1250);
        assert_eq!(json["entryCount"], 2);
        assert_eq!(json["truncated"], false);
        assert_eq!(json["afterSequence"], 7);
        assert_eq!(json["lastSequence"], 9);
        assert_eq!(json["reconnectAttempt"], 3);
        assert_eq!(json["lastServerActivityAgeMs"], 75_000);
        assert_eq!(json["reason"], "heartbeat_timeout");
    }

    #[test]
    fn client_message_unregister_wire_format() {
        let msg = AgentInstanceClientMessage::Unregister {
            request_id: Some("u1".into()),
        };
        let json = serde_json::to_value(&msg).unwrap();
        assert_eq!(json["type"], "unregister");
        assert_eq!(json["requestId"], "u1");
    }

    #[test]
    fn client_message_refresh_auth_wire_format() {
        let msg = AgentInstanceClientMessage::RefreshAuth {
            request_id: Some("r1".into()),
            token: "jwt-token-2".into(),
        };
        let json = serde_json::to_value(&msg).unwrap();
        assert_eq!(json["type"], "refresh_auth");
        assert_eq!(json["requestId"], "r1");
        assert_eq!(json["token"], "jwt-token-2");
    }

    #[test]
    fn client_message_join_channel_wire_format_requires_history_limit() {
        let msg = AgentInstanceClientMessage::JoinChannel {
            request_id: Some("j1".into()),
            channel_id: "ch-1".into(),
            history_limit: 25,
            after_sequence: None,
        };

        let json = serde_json::to_value(&msg).unwrap();
        assert_eq!(json["type"], "join_channel");
        assert_eq!(json["requestId"], "j1");
        assert_eq!(json["channelId"], "ch-1");
        assert_eq!(json["historyLimit"], 25);
        assert_eq!(json.get("afterSequence"), None);
    }

    #[test]
    fn client_message_join_channel_after_sequence_round_trip() {
        let msg = AgentInstanceClientMessage::JoinChannel {
            request_id: None,
            channel_id: "ch-1".into(),
            history_limit: 100,
            after_sequence: Some(42),
        };

        let json = serde_json::to_value(&msg).unwrap();
        assert_eq!(json["type"], "join_channel");
        assert_eq!(json["channelId"], "ch-1");
        assert_eq!(json["historyLimit"], 100);
        assert_eq!(json["afterSequence"], 42);

        let hub_json = r#"{
            "type": "join_channel",
            "channelId": "ch-1",
            "historyLimit": 100,
            "afterSequence": 42
        }"#;
        let decoded: AgentInstanceClientMessage = serde_json::from_str(hub_json).unwrap();
        match decoded {
            AgentInstanceClientMessage::JoinChannel {
                channel_id,
                history_limit,
                after_sequence,
                ..
            } => {
                assert_eq!(channel_id, "ch-1");
                assert_eq!(history_limit, 100);
                assert_eq!(after_sequence, Some(42));
            }
            other => panic!("unexpected variant: {other:?}"),
        }
    }

    #[test]
    fn client_message_replay_channel_history_after_sequence_round_trip() {
        let msg = AgentInstanceClientMessage::ReplayChannelHistory {
            request_id: None,
            channel_id: "ch-1".into(),
            history_limit: 100,
            after_sequence: Some(42),
        };

        let json = serde_json::to_value(&msg).unwrap();
        assert_eq!(json["type"], "replay_channel_history");
        assert_eq!(json["channelId"], "ch-1");
        assert_eq!(json["historyLimit"], 100);
        assert_eq!(json["afterSequence"], 42);

        let hub_json = r#"{
            "type": "replay_channel_history",
            "channelId": "ch-1",
            "historyLimit": 100,
            "afterSequence": 42
        }"#;
        let decoded: AgentInstanceClientMessage = serde_json::from_str(hub_json).unwrap();
        match decoded {
            AgentInstanceClientMessage::ReplayChannelHistory {
                channel_id,
                history_limit,
                after_sequence,
                ..
            } => {
                assert_eq!(channel_id, "ch-1");
                assert_eq!(history_limit, 100);
                assert_eq!(after_sequence, Some(42));
            }
            other => panic!("unexpected variant: {other:?}"),
        }
    }

    #[test]
    fn client_message_channel_message_wire_format() {
        let msg = AgentInstanceClientMessage::ChannelMessage {
            request_id: Some("m1".into()),
            channel_id: "ch-1".into(),
            body: "hello team".into(),
            reply_to_message_id: None,
            app_mentions: None,
            metadata: None,
        };

        let json = serde_json::to_value(&msg).unwrap();
        assert_eq!(json["type"], "channel_message");
        assert_eq!(json["requestId"], "m1");
        assert_eq!(json["channelId"], "ch-1");
        assert_eq!(json["body"], "hello team");
    }

    #[test]
    fn agent_instance_server_protocol_rejects_profile_and_administration_messages() {
        for message in [
            r#"{"type":"registered","agent":{},"agents":[]}"#,
            r#"{"type":"agent_list","agents":[]}"#,
            r#"{"type":"agent_renamed","previousName":"before","agent":{}}"#,
            r#"{"type":"channel_created","channel":{}}"#,
            r#"{"type":"channel_deleted","channelId":"channel-1"}"#,
            r#"{"type":"channel_list","channels":[]}"#,
        ] {
            assert!(
                serde_json::from_str::<AgentInstanceServerMessage>(message).is_err(),
                "retired Agent Instance message unexpectedly decoded: {message}"
            );
        }
    }

    #[test]
    fn server_message_pong_deserialize() {
        let hub_json = r#"{"type":"pong","requestId":"p1","ts":"2026-04-02T00:00:00Z"}"#;
        let msg: AgentInstanceServerMessage = serde_json::from_str(hub_json).unwrap();
        assert!(matches!(msg, AgentInstanceServerMessage::Pong { .. }));
    }

    #[test]
    fn server_message_auth_refreshed_deserialize() {
        let hub_json = r#"{"type":"auth_refreshed","requestId":"r1","ts":"2026-04-02T00:00:00Z"}"#;
        let msg: AgentInstanceServerMessage = serde_json::from_str(hub_json).unwrap();
        assert!(matches!(
            msg,
            AgentInstanceServerMessage::AuthRefreshed { .. }
        ));
    }

    #[test]
    fn server_message_unregistered_deserialize() {
        let hub_json = r#"{"type":"unregistered","requestId":"u1"}"#;
        let msg: AgentInstanceServerMessage = serde_json::from_str(hub_json).unwrap();
        assert!(matches!(
            msg,
            AgentInstanceServerMessage::Unregistered { .. }
        ));
    }

    #[test]
    fn server_message_channel_message_received_deserialize() {
        let hub_json = r#"{
            "type": "channel_message_received",
            "message": {
                "messageId": "msg-2",
                "channelId": "ch-1",
                "from": {
                    "kind": "agent",
                    "label": "peer",
                    "userId": "u1",
                    "email": "x@y.com",
                    "agentName": "peer"
                },
                "body": "hello channel",
                "sentAt": "2026-04-02T00:00:01Z"
            },
            "clientMessageId": "client-msg-2",
            "roleReminder": "retired Role reminder an older hub may still send",
            "interruptRequested": true
        }"#;
        let msg: AgentInstanceServerMessage = serde_json::from_str(hub_json).unwrap();
        assert!(matches!(
            msg,
            AgentInstanceServerMessage::ChannelMessageReceived {
                ref message,
                client_message_id: Some(ref client_message_id),
                interrupt_requested: Some(true),
                ..
            } if message.message_id == "msg-2"
                && message.body == "hello channel"
                && client_message_id == "client-msg-2"
        ));
        // The retired Role reminder is ignored rather than rejected, so a hub
        // that still sends it keeps delivering.
        let reserialized = serde_json::to_value(&msg).unwrap();
        assert!(reserialized.get("roleReminder").is_none());
        // A frame that still carries the message flat is not a message anymore.
        let flat = hub_json.replace(r#""message": {"#, r#""ignored": {"#);
        assert!(serde_json::from_str::<AgentInstanceServerMessage>(&flat).is_err());
    }

    #[test]
    fn agent_instance_protocol_rejects_human_user_notice() {
        let hub_json = r#"{
            "type": "user_notice",
            "noticeId": "notice-1",
            "channelId": "ch-1",
            "code": "unresolved_agent_mention",
            "level": "warning",
            "body": "xMatrix could not find @agent:new.",
            "sentAt": "2026-07-13T00:00:00Z"
        }"#;
        assert!(serde_json::from_str::<AgentInstanceServerMessage>(hub_json).is_err());
    }

    #[test]
    fn server_message_channel_history_replay_deserialize() {
        let hub_json = r#"{
            "type": "channel_history_replay",
            "message": {
                "messageId": "msg-2",
                "channelId": "ch-1",
                "sequence": 8,
                "from": {
                    "kind": "agent",
                    "label": "peer",
                    "userId": "u1",
                    "email": "x@y.com",
                    "agentName": "peer"
                },
                "body": "replayed channel message",
                "sentAt": "2026-04-02T00:00:01Z"
            },
            "roleReminder": "retired Role reminder an older hub may still send",
            "ackRequired": true
        }"#;
        let msg: AgentInstanceServerMessage = serde_json::from_str(hub_json).unwrap();
        assert!(matches!(
            msg,
            AgentInstanceServerMessage::ChannelHistoryReplay { ref message, .. }
                if message.sequence == Some(8)
        ));
    }

    #[test]
    fn server_message_channel_history_deserialize() {
        let hub_json = r#"{
            "type": "channel_history",
            "requestId": "h1",
            "channelId": "ch-1",
            "messages": [{
                "messageId": "msg-1",
                "channelId": "ch-1",
                "sequence": 7,
                "from": {
                    "kind": "agent",
                    "label": "peer",
                    "userId": "u1",
                    "email": "x@y.com",
                    "agentName": "peer"
                },
                "body": "earlier message",
                "attachments": [{
                    "id": "screen-1",
                    "channelId": "ch-1",
                    "messageId": "msg-1",
                    "kind": "image",
                    "name": "screen.png",
                    "mimeType": "image/png",
                    "size": 42,
                    "url": "https://xmatrix.sh/api/xmatrix/channels/ch-1/attachments/screen-1?token=redacted"
                }],
                "mentionReadStatuses": [{
                    "targetId": "agent:u1:codex",
                    "targetKind": "agent_instance",
                    "label": "codex",
                    "status": "unknown"
                }],
                "sentAt": "2026-04-02T00:00:00Z"
            }]
        }"#;
        let msg: AgentInstanceServerMessage = serde_json::from_str(hub_json).unwrap();
        match msg {
            AgentInstanceServerMessage::ChannelHistory {
                request_id,
                channel_id,
                messages,
            } => {
                assert_eq!(request_id.as_deref(), Some("h1"));
                assert_eq!(channel_id, "ch-1");
                assert_eq!(messages.len(), 1);
                assert_eq!(messages[0].message_id, "msg-1");
                assert_eq!(messages[0].sequence, Some(7));
                assert_eq!(messages[0].attachments.as_ref().unwrap()[0].data_url, "");
                assert_eq!(
                    messages[0].attachments.as_ref().unwrap()[0]
                        .channel_id
                        .as_deref(),
                    Some("ch-1")
                );
                assert_eq!(
                    messages[0].attachments.as_ref().unwrap()[0]
                        .message_id
                        .as_deref(),
                    Some("msg-1")
                );
                assert_eq!(
                    messages[0].mention_read_statuses.as_ref().unwrap()[0].target_kind,
                    "agent_instance"
                );
            }
            other => panic!("unexpected message: {other:?}"),
        }
    }

    #[test]
    fn serialized_channel_deserializes_current_hub_schema_without_members() {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct CreateResponse {
            channel: SerializedChannel,
        }

        let hub_json = include_str!("../../../tests/fixtures/channel-create-current.json");

        let response: CreateResponse = serde_json::from_str(hub_json).unwrap();
        assert_eq!(response.channel.id, "ch-1");
        assert_eq!(response.channel.space_id.as_deref(), Some("space-1"));
        assert_eq!(response.channel.updated_at, "2026-05-17T09:20:00.068Z");
        let presence = response.channel.member_presence.as_ref().unwrap();
        assert_eq!(
            presence["user:u1"].avatar_url.as_deref(),
            Some("https://example.com/avatar.png")
        );
        assert_eq!(presence["user:u1"].activity.as_deref(), Some("reading"));
        assert_eq!(presence["user:u1"].focused, Some(true));
        assert_eq!(
            presence["user:u1"].files.as_ref().unwrap(),
            &vec!["packages/cli-rs/src/protocol.rs".to_string()]
        );
        assert_eq!(presence["user:u1"].intent.as_deref(), Some("reviewing"));
        assert_eq!(
            presence["agent:a1"].usage.as_ref().unwrap().total_tokens,
            Some(12)
        );
    }

    #[test]
    fn serialized_channel_accepts_legacy_members_field_as_ignored_extra() {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct ListResponse {
            channels: Vec<SerializedChannel>,
        }

        let hub_json = include_str!("../../../tests/fixtures/channel-list-legacy-members.json");

        let response: ListResponse = serde_json::from_str(hub_json).unwrap();
        assert_eq!(response.channels[0].id, "ch-legacy");
        assert_eq!(response.channels[0].updated_at, "");
    }

    #[test]
    fn serialized_automation_deserializes_channel_message_contract() {
        let hub_json = r#"{
            "id":"task-1",
            "ownerUserId":"user-1",
            "name":"Daily triage",
            "channelId":"channel-1",
            "canManage":true,
            "version":3,
            "authorityRootUserId":"user-1",
            "capabilities":{"update":true,"pause":true,"requestPause":false,"resume":false,"delete":true,"reasonRequired":false},
            "message":{"body":"@codex:once:/tmp/xmatrix Triage failures"},
            "intervalMinutes":60,
            "enabled":true,
            "createdAt":"2026-08-04T00:00:00.000Z",
            "updatedAt":"2026-08-04T00:00:00.000Z",
            "nextRunAt":"2026-08-04T01:00:00.000Z",
            "latestExecution":{
                "status":"pending",
                "attempts":2,
                "scheduledFor":"2026-08-04T00:45:00.000Z",
                "nextAttemptAt":"2026-08-04T00:47:00.000Z",
                "updatedAt":"2026-08-04T00:46:00.000Z",
                "errorCode":"dispatch_retry",
                "errorMessage":"daemon unavailable"
            },
            "deliveryCount":1,
            "lastDeliveryAt":"2026-08-04T00:30:00.000Z",
            "lastMessageId":"scheduled-message:one",
            "runCount":1
        }"#;
        let automation: SerializedAutomation = serde_json::from_str(hub_json).unwrap();
        assert_eq!(
            automation.message.body,
            "@codex:once:/tmp/xmatrix Triage failures"
        );
        assert_eq!(automation.delivery_count, 1);
        assert!(automation.can_manage);
        assert_eq!(automation.version, 3);
        assert!(automation.capabilities.pause);
        assert_eq!(
            automation
                .latest_execution
                .as_ref()
                .unwrap()
                .error_message
                .as_deref(),
            Some("daemon unavailable")
        );
        assert_eq!(
            automation.last_message_id.as_deref(),
            Some("scheduled-message:one")
        );
        assert!(automation.agent_id.is_none());
        assert!(automation.workspace.is_none());
    }

    #[test]
    fn server_message_error_deserialize() {
        let hub_json = r#"{"type":"error","message":"bad request"}"#;
        let msg: AgentInstanceServerMessage = serde_json::from_str(hub_json).unwrap();
        assert!(matches!(msg, AgentInstanceServerMessage::Error { .. }));
    }

    #[test]
    fn server_message_presence_deserialize() {
        let hub_json = r#"{
            "type": "presence", "online": true,
            "agent": {
                "id": "a1", "userId": "u1", "name": "agent",
                "type": "cursor", "email": "x@y.com", "metadata": {},
                "connectedAt": "2026-04-02T00:00:00Z",
                "lastSeenAt": "2026-04-02T00:00:00Z", "status": "online"
            }
        }"#;
        let msg: AgentInstanceServerMessage = serde_json::from_str(hub_json).unwrap();
        assert!(matches!(
            msg,
            AgentInstanceServerMessage::Presence { online: true, .. }
        ));
    }

    #[test]
    fn client_message_agent_lifecycle_wire_format() {
        let msg = AgentInstanceClientMessage::AgentLifecycle {
            request_id: None,
            channel_id: Some("ch1".into()),
            agent_id: Some("agent:a1".into()),
            instance_id: Some("inst1".into()),
            agent_name: Some("codex".into()),
            layer: "application".into(),
            status: "failed".into(),
            reason: Some("codex_timeout".into()),
            detail: Some("turn timed out".into()),
            snapshot: Some(AgentLifecycleSnapshot {
                presence: Some("online".into()),
                run: Some("failed".into()),
                process: Some("online".into()),
            }),
            resets_at: None,
            ts: None,
        };
        let json = serde_json::to_value(&msg).unwrap();
        assert_eq!(json["type"], "agent_lifecycle");
        assert_eq!(json["channelId"], "ch1");
        assert_eq!(json["reason"], "codex_timeout");
        assert_eq!(json["snapshot"]["run"], "failed");
    }

    #[test]
    fn server_message_agent_lifecycle_deserialize() {
        let hub_json = r#"{"type":"agent_lifecycle","channelId":"ch1","agentId":"agent:a1","instanceId":"inst1","agentName":"codex","layer":"transport","status":"reconnected","reason":"reconnected","snapshot":{"presence":"online","process":"online"},"ts":"2026-04-02T00:00:00Z"}"#;
        let msg: AgentInstanceServerMessage = serde_json::from_str(hub_json).unwrap();
        match msg {
            AgentInstanceServerMessage::AgentLifecycle {
                channel_id,
                status,
                reason,
                snapshot,
                ..
            } => {
                assert_eq!(channel_id.as_deref(), Some("ch1"));
                assert_eq!(status, "reconnected");
                assert_eq!(reason.as_deref(), Some("reconnected"));
                assert_eq!(
                    snapshot.and_then(|value| value.presence).as_deref(),
                    Some("online")
                );
            }
            other => panic!("unexpected message: {other:?}"),
        }
    }

    #[test]
    fn agent_model_control_wire_format() {
        let request: AgentInstanceServerMessage = serde_json::from_str(
            r#"{"type":"agent_model_switch_requested","requestId":"req-1","model":"gpt-5.5"}"#,
        )
        .unwrap();
        assert!(matches!(
            request,
            AgentInstanceServerMessage::AgentModelSwitchRequested { request_id, model }
                if request_id == "req-1" && model == "gpt-5.5"
        ));

        let result = AgentInstanceClientMessage::AgentModelSwitchResult {
            request_id: "req-1".into(),
            model: Some("gpt-5.5".into()),
            error: None,
        };
        let json = serde_json::to_value(result).unwrap();
        assert_eq!(json["type"], "agent_model_switch_result");
        assert_eq!(json["requestId"], "req-1");
        assert_eq!(json["model"], "gpt-5.5");
    }

    #[test]
    fn agent_effort_control_wire_format() {
        let request: AgentInstanceServerMessage = serde_json::from_str(
            r#"{"type":"agent_effort_switch_requested","requestId":"req-2","effort":"high"}"#,
        )
        .unwrap();
        assert!(matches!(
            request,
            AgentInstanceServerMessage::AgentEffortSwitchRequested { request_id, effort }
                if request_id == "req-2" && effort == "high"
        ));

        let result = AgentInstanceClientMessage::AgentEffortSwitchResult {
            request_id: "req-2".into(),
            effort: Some("high".into()),
            error: None,
        };
        let json = serde_json::to_value(result).unwrap();
        assert_eq!(json["type"], "agent_effort_switch_result");
        assert_eq!(json["requestId"], "req-2");
        assert_eq!(json["effort"], "high");
    }

    #[test]
    fn presence_goal_patch_distinguishes_omit_clear_and_value() {
        let presence = |goal| AgentInstanceClientMessage::PresenceUpdate {
            request_id: None,
            status: Some("idle".into()),
            activity: None,
            files: None,
            intent: None,
            git_branch: None,
            capabilities: None,
            runtime_state: None,
            goal,
            model: None,
            models: None,
            effort: None,
            commands: None,
            parameters: None,
            status_chips: None,
            usage: None,
        };

        let omitted = serde_json::to_value(presence(None)).unwrap();
        assert!(omitted.get("goal").is_none());

        let cleared = serde_json::to_value(presence(Some(None))).unwrap();
        assert!(cleared.get("goal").is_some_and(serde_json::Value::is_null));

        let value = serde_json::to_value(presence(Some(Some(AgentGoalStatus {
            active: Some(true),
            objective: Some("ship it".into()),
            status: Some("active".into()),
            ..Default::default()
        }))))
        .unwrap();
        assert_eq!(value["goal"]["objective"], "ship it");
    }

    #[test]
    fn normalize_hub_url_cases() {
        assert_eq!(normalize_hub_url(None), DEFAULT_HUB_URL);
        assert_eq!(
            normalize_hub_url(Some("https://example.com/")),
            "https://example.com"
        );
        assert_eq!(
            normalize_hub_url(Some("ws://localhost:8787/ws")),
            "http://localhost:8787"
        );
        assert_eq!(
            normalize_hub_url(Some("wss://hub.example.com/ws")),
            "https://hub.example.com"
        );
    }
}
