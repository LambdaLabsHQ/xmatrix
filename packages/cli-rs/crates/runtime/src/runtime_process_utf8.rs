use xmatrix_cli_account::{cmd_list, cmd_login, cmd_logout, cmd_status, cmd_whoami};
use xmatrix_cli_agent::{apply_agent_spawn_path, cmd_agent};
use xmatrix_cli_args as cli;
pub use xmatrix_cli_channel::{
    agent_sender_env_value, channel_image_mime_type, channel_label, channel_name_from_cache,
    format_history_message, load_channel_image_attachments,
};
use xmatrix_cli_channel::{
    cmd_channel, cmd_channels, cmd_decision_evidence, cmd_diagnose, cmd_message_receipt, cmd_space,
    cmd_spaces,
};
pub use xmatrix_cli_core::{
    agent_instance_connection, attachment_cache, auth, bootstrap, config, daemon_auth, error,
    git_credential, http, machine_daemon_connection, protocol,
};
use xmatrix_cli_machine::{cmd_config, cmd_machine};
pub use xmatrix_cli_migrate as slack_migrate;
pub use xmatrix_cli_terminal::{ansi, detect, kkp, pty, terminal};
pub use xmatrix_cli_workspace::normalize_workspace_path_string_for_storage;

mod agent_presentation;
mod claude_parameters;
mod harness_parameter_toggles;
mod harness_parameters;
use xmatrix_process_tree as process_tree;
use xmatrix_repo_pool::{repo_pool, run_worktree};

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::fs::OpenOptions;
use std::future::Future;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use colored::Colorize;
use fs2::FileExt;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest as _, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::{Mutex as AsyncMutex, RwLock, mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message as WsMessage;

#[cfg(test)]
use agent_presentation::acp_model_catalog_from_value;
use agent_presentation::{
    AgentPresentationAdapter, AgentPresentationFacts, AgentPresentationSnapshot,
    BuiltinAgentPresentationAdapter, agent_commands_for_runtime,
    agent_commands_for_runtime_with_overlay, agent_presentation_adapter_for_acp_runtime,
    agent_presentation_adapter_for_runtime, models_support_efforts, normalize_slash_command_token,
    resolve_switchable_model,
};
use cli::{
    AttachmentCommand, Cli, CliEnvironmentArg, Commands, DaemonCommand, EnvironmentCommand,
    ManagementCommand, MigrateCommand, MigrationHistoryMode, ProfileCommand, RequestCommand,
    SecretCommand, SetupCommand,
};
use config::CliSession;
use error::CliError;
use machine_daemon_connection::{
    MachineDaemonActivationConnect, MachineDaemonCommand, MachineDaemonCommandLease,
    MachineDaemonConnectionClient, MachineDaemonConnectionEvent, MachineDaemonReport,
    MachineHandoffExport, MachineHandoffExportResult, MachineRunSnapshotItem,
    MachineWorktreeDisposition, SerializedMachineDaemon,
};
#[cfg(windows)]
use machine_daemon_connection::{MachineDaemonActivationReceipt, MachineDaemonAdoptedRunEvidence};
use protocol::{DEFAULT_HUB_URL, HubRoutes, TEST_HUB_URL, normalize_hub_url, with_route};
use xmatrix_cli_memory::{cmd_annotation, cmd_page};
#[cfg(windows)]
use xmatrix_cli_update::WindowsStagedDaemonCandidate;
pub use xmatrix_cli_update::maybe_run_update_handoff_from_env;
pub use xmatrix_cli_update::{
    CliReleaseManifest, latest_release_manifest_version, release_version_cmp,
    release_version_is_newer, update_hint_lines,
};
use xmatrix_cli_update::{
    CliUpdateCheck, DEFAULT_CLI_RELEASE_API_URL, UpdateHintTarget, check_cli_update, cmd_update,
    print_update_hint,
};
use xmatrix_cli_update::{InstalledCliUpdate, install_cli_update_for_daemon_restart};
use xmatrix_cli_update::{install_cli_from_seed, install_daemon_service};
use xmatrix_cli_workspace::{
    cmd_workspace, list_machine_daemon_workspaces, observed_hostname, upsert_workspace,
    validate_daemon_workspace_allowed, validate_daemon_workspace_path_isolated,
};

type SharedMachineDaemonConnection = Arc<MachineDaemonConnectionClient>;

pub fn configure_process_utf8() {
    terminal::configure_process_utf8();
}

/// One default a Windows harness child gets so its shells and tools read and
/// write UTF-8. `respects` lists the variables that, when the user or caller
/// already set any of them, leave the default out.
struct WindowsUtf8EnvDefault {
    key: &'static str,
    value: &'static str,
    respects: &'static [&'static str],
}

/// Python (including tools written in it) and Git Bash/MSYS (via `LANG`) use
/// UTF-8 for text and pipes. `LANG` is skipped when any locale variable is
/// already set, so a configured locale is never replaced. The system ANSI
/// code page itself is never changed.
const WINDOWS_UTF8_CHILD_ENV: &[WindowsUtf8EnvDefault] = &[
    WindowsUtf8EnvDefault {
        key: "PYTHONUTF8",
        value: "1",
        respects: &["PYTHONUTF8"],
    },
    WindowsUtf8EnvDefault {
        key: "PYTHONIOENCODING",
        value: "utf-8",
        respects: &["PYTHONIOENCODING"],
    },
    WindowsUtf8EnvDefault {
        key: "LANG",
        value: "C.UTF-8",
        respects: &["LANG", "LC_ALL", "LC_CTYPE"],
    },
    WindowsUtf8EnvDefault {
        key: "DOTNET_SYSTEM_CONSOLE_ALLOW_ANSI_COLOR_REDIRECTION",
        value: "1",
        respects: &["DOTNET_SYSTEM_CONSOLE_ALLOW_ANSI_COLOR_REDIRECTION"],
    },
];

/// The UTF-8 defaults not already decided by `is_configured` (which sees the
/// caller's explicit child env and the daemon's own environment).
fn windows_utf8_env_defaults(
    is_configured: impl Fn(&str) -> bool,
) -> Vec<(&'static str, &'static str)> {
    WINDOWS_UTF8_CHILD_ENV
        .iter()
        .filter(|default| !default.respects.iter().any(|key| is_configured(key)))
        .map(|default| (default.key, default.value))
        .collect()
}

/// Whether `key` is set (Windows names are case-insensitive) in `explicit` or
/// in this process's environment, which the child would inherit.
fn utf8_env_key_configured<'a>(
    key: &str,
    mut explicit: impl Iterator<Item = &'a std::ffi::OsStr>,
) -> bool {
    explicit.any(|name| name.to_string_lossy().eq_ignore_ascii_case(key))
        || std::env::vars_os().any(|(name, _)| name.to_string_lossy().eq_ignore_ascii_case(key))
}

fn apply_windows_utf8_env(command: &mut std::process::Command) {
    if !cfg!(windows) {
        return;
    }
    let defaults = windows_utf8_env_defaults(|key| {
        utf8_env_key_configured(key, command.get_envs().map(|(name, _)| name))
    });
    command.envs(defaults);
}

fn apply_windows_utf8_env_tokio(command: &mut tokio::process::Command) {
    if !cfg!(windows) {
        return;
    }
    let defaults = windows_utf8_env_defaults(|key| {
        utf8_env_key_configured(key, command.as_std().get_envs().map(|(name, _)| name))
    });
    command.envs(defaults);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
}

/// A vendor app-server child, bound to its process tree, whose stdout carries
/// its protocol or its banner.
struct AppServerChild {
    child: tokio::process::Child,
    process_tree: process_tree::ProcessTreeGuard,
    stdout: tokio::process::ChildStdout,
    label: &'static str,
}

impl AppServerChild {
    /// Spawn `cmd app_args` with stdout piped and stderr inherited. `stdin` is
    /// piped for a stdio transport and null for one served over a socket;
    /// `configure` adds what the vendor needs on top. `label` names the server
    /// in errors.
    fn spawn(
        cmd: &str,
        app_args: &[String],
        cwd: Option<&str>,
        stdin: Stdio,
        label: &'static str,
        configure: impl FnOnce(&mut tokio::process::Command),
    ) -> error::Result<Self> {
        let (spawn_cmd, spawn_args) = shell_wrap(cmd, app_args);
        let mut command = tokio::process::Command::new(&spawn_cmd);
        apply_windows_utf8_env_tokio(&mut command);
        command
            .args(&spawn_args)
            .stdin(stdin)
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        configure(&mut command);
        if let Some(dir) = cwd {
            command.current_dir(dir);
        }
        process_tree::configure_tokio_process_tree(&mut command);

        let mut child = command
            .spawn()
            .map_err(|err| CliError::Launch(format!("Failed to start {label}: {err}")))?;
        let process_tree = process_tree::guard_tokio_child(&mut child).map_err(|err| {
            CliError::Launch(format!("Failed to bind {label} to its process tree: {err}"))
        })?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| CliError::Launch(format!("{label} stdout unavailable")))?;
        Ok(Self {
            child,
            process_tree,
            stdout,
            label,
        })
    }

    fn take_stdin(&mut self) -> error::Result<tokio::process::ChildStdin> {
        self.child
            .stdin
            .take()
            .ok_or_else(|| CliError::Launch(format!("{} stdin unavailable", self.label)))
    }
}

type AppServerWsWrite = futures_util::stream::SplitSink<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    WsMessage,
>;

/// The write half of an app-server's protocol: its stdin, or the WebSocket it
/// serves.
#[derive(Clone)]
enum AppServerWrite {
    Stdio(Arc<AsyncMutex<ChildStdin>>),
    WebSocket(Arc<AsyncMutex<AppServerWsWrite>>),
}

impl AppServerWrite {
    /// Send one JSON message. `stdio_label` and `ws_label` name the channel in
    /// errors for each transport.
    async fn send(&self, value: &Value, stdio_label: &str, ws_label: &str) -> error::Result<()> {
        let payload = serde_json::to_string(value)?;
        match self {
            Self::Stdio(stdin) => write_json_line(stdin, payload.into_bytes(), stdio_label)
                .await
                .map_err(CliError::Launch),
            Self::WebSocket(ws) => {
                let mut ws = ws.lock().await;
                ws.send(WsMessage::Text(payload.into()))
                    .await
                    .map_err(|err| CliError::Launch(format!("{ws_label} write failed: {err}")))
            }
        }
    }
}

/// Write one serialized message as a line and flush it. `label` names the
/// stream in errors.
async fn write_json_line(
    stdin: &AsyncMutex<ChildStdin>,
    mut line: Vec<u8>,
    label: &str,
) -> Result<(), String> {
    line.push(b'\n');
    let mut stdin = stdin.lock().await;
    stdin
        .write_all(&line)
        .await
        .map_err(|err| format!("{label} write failed: {err}"))?;
    stdin
        .flush()
        .await
        .map_err(|err| format!("{label} flush failed: {err}"))
}

/// The workspace an app-server session opens: the run's cwd, else this
/// process's working directory.
fn app_server_workspace_path(cwd: Option<&str>) -> error::Result<String> {
    let path = match cwd {
        Some(path) => PathBuf::from(path),
        None => std::env::current_dir()
            .map_err(|err| CliError::Launch(format!("Failed to resolve current dir: {err}")))?,
    };
    Ok(path.to_string_lossy().to_string())
}

/// Stop an app-server child and its process tree, then reap it.
async fn terminate_app_server(
    process_tree: &mut process_tree::ProcessTreeGuard,
    child: &mut tokio::process::Child,
) {
    let _ = process_tree.terminate();
    let _ = child.kill().await;
    let _ = child.wait().await;
}

/// The loopback address an app-server serves its WebSocket on: `bind_env`
/// when set, else a port the OS has just handed out. `server` names it in
/// errors.
fn loopback_ws_bind_address(bind_env: &str, server: &str) -> error::Result<String> {
    if let Some(bind) = non_empty_env(bind_env) {
        return Ok(bind);
    }
    let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|err| {
        CliError::Launch(format!(
            "Failed to allocate loopback port for {server}: {err}"
        ))
    })?;
    let port = listener
        .local_addr()
        .map_err(|err| CliError::Launch(format!("Failed to read allocated {server} port: {err}")))?
        .port();
    drop(listener);
    Ok(format!("127.0.0.1:{port}"))
}

fn append_windows_utf8_env(env_vars: &mut Vec<(String, String)>) {
    if !cfg!(windows) {
        return;
    }
    let defaults = windows_utf8_env_defaults(|key| {
        utf8_env_key_configured(
            key,
            env_vars.iter().map(|(name, _)| std::ffi::OsStr::new(name)),
        )
    });
    env_vars.extend(
        defaults
            .into_iter()
            .map(|(key, value)| (key.to_string(), value.to_string())),
    );
}

const ACCESS_TOKEN_REFRESH_AGE_SECS: u64 = 45 * 60;
const CONNECTED_TOKEN_REFRESH_INTERVAL_SECS: u64 = 20 * 60;
const SESSION_REFRESH_EXPIRY_MARGIN_SECS: u64 = 5 * 60;
const SESSION_REFRESH_RETRY_DELAY_SECS: u64 = 30;
const AGENT_RUN_TOKEN_REFRESH_INTERVAL_SECS: u64 = 8 * 60;
const CODEX_APP_REQUEST_TIMEOUT_SECS: u64 = 60;
// stop/reborn must let Codex persist an interrupted terminal state before the
// app-server process tree is terminated. Keep this comfortably inside the
// daemon's stop-result timeout so an unresponsive provider still gets killed.
const CODEX_SHUTDOWN_INTERRUPT_GRACE_SECS: u64 = 2;
const AGENT_RELAY_DISCONNECT_TIMEOUT_SECS: u64 = 5;
// Once the app-server reports its final reconnect attempt, it may go silent
// instead of emitting a terminal error; allow a bounded HTTPS fallback window
// before declaring the connection lost.
const CODEX_RECONNECT_EXHAUSTED_GRACE_SECS: u64 = 180;
const CODEX_TRACE_DELTA_FLUSH_BYTES: usize = 160;
const CODEX_TRACE_DELTA_FLUSH_MS: u64 = 400;
const CODEX_RUNTIME_TRACE_STRING_LIMIT: usize = 1200;
const CODEX_RUNTIME_TRACE_SUMMARY_LIMIT: usize = 200;
const CODEX_RUNTIME_TRACE_RAW_PREVIEW_LIMIT: usize = 3000;
const CODEX_RUNTIME_TRACE_ARRAY_LIMIT: usize = 20;
const CODEX_RUNTIME_TRACE_OBJECT_LIMIT: usize = 40;
const GIT_PROBE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq, Eq)]
enum CodexTransportRecoveryState {
    Healthy,
    WebsocketReconnecting,
    AwaitingHttpsFallback { last_error: String },
}

impl CodexTransportRecoveryState {
    fn observe_non_error_event(&mut self) {
        *self = Self::Healthy;
    }

    fn observe_transport_error(&mut self, error: &str) -> bool {
        if codex_app_error_is_https_fallback(error) {
            *self = Self::Healthy;
            return true;
        }
        if !codex_app_error_is_transient_transport(error) {
            return false;
        }
        *self = match codex_reconnect_attempts(error) {
            Some((attempt, max_attempts)) if attempt >= max_attempts => {
                Self::AwaitingHttpsFallback {
                    last_error: error.to_string(),
                }
            }
            _ => Self::WebsocketReconnecting,
        };
        true
    }

    fn awaiting_https_fallback(&self) -> bool {
        matches!(self, Self::AwaitingHttpsFallback { .. })
    }

    fn last_exhausted_error(&self) -> Option<&str> {
        match self {
            Self::AwaitingHttpsFallback { last_error } => Some(last_error),
            _ => None,
        }
    }
}

const INBOUND_DELIVERY_BATCH_MAX_MESSAGES_ENV: &str = "XMATRIX_INBOUND_DELIVERY_BATCH_MAX_MESSAGES";
const DEFAULT_INBOUND_DELIVERY_BATCH_MAX_MESSAGES: usize = 25;
const LONG_LIVED_REGISTER_RETRY_BASE_MS: u64 = 1_000;
const LONG_LIVED_REGISTER_RETRY_MAX_MS: u64 = 30_000;
const LONG_LIVED_REGISTER_RETRY_JITTER_MS: u64 = 500;
const DEFAULT_DAEMON_SELF_UPDATE_INTERVAL_SECS: u64 = 30 * 60;
const DAEMON_SELF_UPDATE_STARTUP_TIMEOUT_SECS: u64 = 15;
const DAEMON_SELF_UPDATE_PERIODIC_TIMEOUT_SECS: u64 = 120;
const DAEMON_CONTROL_LONG_POLL_WAIT_MS: u64 = 25_000;
const DAEMON_CONTROL_REQUEST_TIMEOUT_MS: u64 = 40_000;
const DAEMON_COMMAND_LEASE_RENEW_INTERVAL_SECS: u64 = 15;
const DAEMON_COMMAND_LEASE_RENEW_FAILURE_WINDOW_SECS: u64 = 35;
const DAEMON_COMMAND_LEASE_RENEW_REQUEST_TIMEOUT_SECS: u64 = 10;
const DAEMON_COMMAND_ADMISSION_REQUEST_TIMEOUT_SECS: u64 = 10;
const DAEMON_CONTROL_RESULT_REQUEST_TIMEOUT_SECS: u64 = 5;
#[cfg(test)]
const DAEMON_COMMAND_LEASE_RENEWED_TTL_SECS: u64 = 60;
// HTTP claim is not a live-epoch heartbeat. A connected daemon waits for Hub
// evict / disconnect; a new socket performs one catch-up. Pace local reconnect
// observation without an HTTP hot loop.
const DAEMON_CONTROL_DISCONNECTED_WAIT_MS: u64 = 2_000;
const DAEMON_CONTROL_CONNECTION_CHECK_INTERVAL_MS: u64 = 1_000;
const DAEMON_CONTROL_POLL_RETRY_BASE_MS: u64 = 1_000;
const DAEMON_CONTROL_POLL_RETRY_MAX_MS: u64 = 2_000;
const DAEMON_CONTROL_POLL_RETRY_JITTER_MS: u64 = 500;
// Authority returns at most five commands per claim. The HTTP recovery path
// may execute that bounded batch concurrently, then immediately drain once
// more before returning to the healthy ten-second safety cadence.
const DAEMON_CONTROL_FALLBACK_BATCH_MAX_COMMANDS: usize = 5;
const DAEMON_AUTH_URL_ENV: &str = "XMATRIX_DAEMON_AUTH_URL";
const DAEMON_AUTH_CAPABILITY_ENV: &str = "XMATRIX_DAEMON_AUTH_CAPABILITY";
const DAEMON_REQUEST_URL_ENV: &str = "XMATRIX_DAEMON_REQUEST_URL";
const DAEMON_REQUEST_CAPABILITY_ENV: &str = "XMATRIX_DAEMON_REQUEST_CAPABILITY";
const DAEMON_REQUEST_OUTPUT_LIMIT: usize = 1024 * 1024;
const DAEMON_HUB_UPLOAD_INPUT_LIMIT: usize = 64 * 1024 * 1024;
const DAEMON_AUTH_REFRESH_RETRY_SECS: u64 = 30;
const DAEMON_RUN_STATUS_HEARTBEAT_SECS: u64 = 30;
const DAEMON_RUN_RECOVERY_MAX_AGE_MILLIS: u64 = 2 * 60 * 1000;
const DAEMON_RUN_ARTIFACT_RETENTION_GRACE_MILLIS: u64 = 2 * 60 * 1000;
const DAEMON_RUN_ARTIFACT_RETENTION_MAX_AGE_MILLIS: u64 = 7 * 24 * 60 * 60 * 1000;
const DAEMON_RUN_ARTIFACT_RETENTION_MAX_GROUPS: usize = 128;
const DAEMON_REGISTRY_AUDIT_MAX_BYTES: u64 = 5 * 1024 * 1024;
const ATTACHMENT_FETCH_MAX_BYTES: u64 = 1024 * 1024 * 1024;
static DAEMON_REGISTRY_AUDIT_LOCK: Mutex<()> = Mutex::new(());
static DAEMON_RUN_STATUS_WRITE_LOCK: Mutex<()> = Mutex::new(());

#[cfg(target_os = "macos")]
struct MacosSleepGuard {
    child: Option<std::process::Child>,
}

#[cfg(target_os = "macos")]
impl MacosSleepGuard {
    fn acquire(label: &str) -> Self {
        let pid = std::process::id().to_string();
        let child = std::process::Command::new("caffeinate")
            .args(["-ims", "-w", &pid])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|err| {
                eprintln!(
                    "{} macOS sleep guard unavailable for {label}: {err}",
                    "⚠".yellow().bold()
                );
            })
            .ok();

        if child.is_some() {
            eprintln!(
                "{} macOS sleep guard active for {label}",
                "✓".green().bold()
            );
        }

        Self { child }
    }
}

#[cfg(target_os = "macos")]
impl Drop for MacosSleepGuard {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[cfg(not(target_os = "macos"))]
struct MacosSleepGuard;

#[cfg(not(target_os = "macos"))]
impl MacosSleepGuard {
    fn acquire(_label: &str) -> Self {
        Self
    }
}

pub async fn run(mut cli: Cli) -> error::Result<()> {
    // Refuse before the lifetime binding and the status heartbeat: a nested
    // command must leave its parent Run's status file untouched.
    if let Some(Commands::External(args)) = &cli.command
        && let Some(refusal) = nested_external_command_refusal(args)
    {
        return Err(refusal);
    }
    if env_flag("XMATRIX_HEADLESS") || env_flag("XMATRIX_AGENT_SESSION") {
        http::mark_process_as_daemon();
    }
    if env_flag("XMATRIX_HEADLESS") {
        process_tree::bind_current_process_lifetime().map_err(|err| {
            CliError::Launch(format!(
                "Failed to bind headless agent wrapper to its process-tree lifetime: {err}"
            ))
        })?;
        #[cfg(windows)]
        runtime_windows_run_adoption::complete_wrapper_bootstrap()?;
    }
    let _run_status_heartbeat = spawn_current_run_status_heartbeat();
    let _daemon_handoff_request_watch = spawn_daemon_handoff_request_watch();
    if matches!(&cli.command, Some(Commands::Profile { .. })) {
        if env_flag("XMATRIX_HEADLESS") || env_flag("XMATRIX_AGENT_SESSION") {
            return Err(CliError::Auth(
                "Agent runs cannot inspect or mutate the installation profile registry".into(),
            ));
        }
        let Some(Commands::Profile { command }) = cli.command.take() else {
            unreachable!("profile command shape changed after inspection");
        };
        return cmd_profile(command).await;
    }
    if matches!(&cli.command, Some(Commands::Daemon { command: None })) {
        if env_flag("XMATRIX_HEADLESS") || env_flag("XMATRIX_AGENT_SESSION") {
            return Err(CliError::Auth(
                "Agent runs cannot start the installation daemon host".into(),
            ));
        }
        return cmd_daemon_installation(cli.hub_url.as_deref(), cli.token.as_deref()).await;
    }
    let agent_runtime = env_flag("XMATRIX_HEADLESS") || env_flag("XMATRIX_AGENT_SESSION");
    let hub_url = if env_flag("XMATRIX_AGENT_SESSION") && !env_flag("XMATRIX_HEADLESS") {
        admit_agent_cli_hub(&cli)?
    } else {
        let pinned_profile_id = std::env::var("XMATRIX_RUN_PROFILE_ID").ok();
        let admitted_selector = cli.profile.as_deref().or_else(|| {
            agent_runtime
                .then_some(pinned_profile_id.as_deref())
                .flatten()
        });
        let (hub_url, profile_context) =
            resolve_target_profile(admitted_selector, cli.environment, cli.hub_url.as_deref())
                .await?;
        let cross_hub_override = cli.hub_url.is_some() && hub_url != profile_context.hub_origin;
        let long_lived_hub_runtime = matches!(
            &cli.command,
            Some(Commands::Daemon { .. }) | Some(Commands::External(_))
        );
        if cross_hub_override
            && (agent_runtime
                || profile_context.state_kind
                    == xmatrix_cli_core::profile::ProfileStateKind::Isolated
                || long_lived_hub_runtime)
        {
            return Err(CliError::Auth(format!(
                "Profile `{}` is bound to {}; create or select a profile for {} instead of overriding its Hub",
                profile_context.name, profile_context.hub_origin, hub_url
            )));
        }
        validate_agent_profile_lineage(
            agent_runtime,
            pinned_profile_id.as_deref(),
            &profile_context.id,
            profile_context.state_kind,
        )?;
        xmatrix_cli_core::profile::ProfileStore::discover()
            .prepare_context_state_root(&profile_context)?;
        config::install_process_profile_context(profile_context)?;
        hub_url
    };
    let local_harness = matches!(
        &cli.command,
        Some(Commands::Harness {
            command: xmatrix_cli_args::HarnessCommand::List { local: true, .. }
                | xmatrix_cli_args::HarnessCommand::Apply { .. }
        })
    ) || (xmatrix_cli_channel::running_inside_agent_execution_context()
        && matches!(
            &cli.command,
            Some(Commands::Harness {
                command: xmatrix_cli_args::HarnessCommand::List { machine: None, .. }
            })
        ));
    if !local_harness
        && !matches!(
            &cli.command,
            Some(Commands::Login { .. })
                | Some(Commands::Logout { .. })
                | Some(Commands::Session { .. })
                | Some(Commands::Env { .. })
        )
    {
        xmatrix_cli_core::access::prepare_for_hub(&hub_url, false).await?;
    }

    match cli.command {
        Some(Commands::Login {
            machine_name,
            connect,
        }) => cmd_login(&hub_url, machine_name.as_deref(), connect.as_deref()).await,
        Some(Commands::Session { command }) => {
            crate::runtime_session_commands::cmd_session(&hub_url, command).await
        }
        Some(Commands::Logout { all, all_profiles }) => {
            if all_profiles && agent_runtime {
                return Err(CliError::Auth(
                    "Agent runs cannot clear credentials across local profiles".into(),
                ));
            }
            cmd_logout(&hub_url, all, all_profiles).await
        }
        Some(Commands::Whoami) => cmd_whoami(&hub_url).await,
        Some(Commands::Billing { command }) => {
            use xmatrix_cli_account::billing::{self, Query};
            use xmatrix_cli_args::{BillingCommand, SpaceBillingCommand};
            match command {
                BillingCommand::Space {
                    command: SpaceBillingCommand::Status { space, json },
                } => {
                    let token = resolve_auth_token(cli.token.as_deref(), &hub_url).await?;
                    billing::query(&hub_url, &token, Query::SpaceStatus(space), json).await
                }
                BillingCommand::Open => {
                    if xmatrix_cli_channel::running_inside_agent_execution_context() {
                        return Err(CliError::Auth("Agent runs cannot open personal billing; ask the owner to run xmatrix billing open".into()));
                    }
                    let url = billing::page_url(&hub_url)?;
                    open::that(url).map_err(|e| {
                        CliError::Launch(format!("Could not open billing page: {e}"))
                    })?;
                    println!("Opened {url}");
                    Ok(())
                }
            }
        }
        Some(Commands::Env { command }) => cmd_environment(command).await,
        Some(Commands::Profile { .. }) => unreachable!("profile commands return before admission"),
        Some(Commands::GitCredential { operation }) => cmd_git_credential(&operation).await,
        Some(Commands::Status) => cmd_status(&hub_url).await,
        Some(Commands::Diagnose {
            target,
            run,
            limit,
            message,
            receipt,
            decision_evidence,
            json,
        }) => {
            let token = resolve_auth_token(cli.token.as_deref(), &hub_url).await?;
            if let Some(ref_id) = decision_evidence {
                cmd_decision_evidence(
                    &hub_url,
                    &token,
                    &target,
                    message.as_deref().unwrap_or(""),
                    &ref_id,
                )
                .await
            } else if let Some(id) = receipt {
                cmd_message_receipt(&hub_url, &token, &target, &id, json).await
            } else {
                cmd_diagnose(
                    &hub_url,
                    &token,
                    &target,
                    run,
                    limit,
                    message.as_deref(),
                    json,
                )
                .await
            }
        }
        Some(Commands::Update {
            release_api_url,
            force,
        }) => cmd_update(&release_api_url, force, &hub_url).await,
        Some(Commands::UpdateSelf) => cmd_update_self().await,
        Some(Commands::Setup {
            machine_name,
            command:
                SetupCommand::Install {
                    from,
                    into,
                    daemon,
                    json,
                },
        }) => {
            let installed = install_cli_from_seed(from.as_deref(), into.as_deref())?;
            let service = if daemon {
                ensure_setup_machine_name(&hub_url, machine_name.as_deref()).await?;
                Some(install_daemon_service(Some(&installed.path))?)
            } else {
                None
            };
            if json {
                println!(
                    "{}",
                    serde_json::json!({
                        "installedPath": installed.path,
                        "installDir": installed.install_dir,
                        "version": installed.version,
                        "daemon": service.as_ref().map(|service| serde_json::json!({
                            "manager": service.manager,
                            "definitionPath": service.definition_path,
                        })),
                    })
                );
            } else {
                println!(
                    "xMatrix CLI ({}) installed at {}",
                    installed.version,
                    installed.path.display()
                );
                if let Some(service) = &service {
                    println!(
                        "xMatrix daemon registered with {} at {}",
                        service.manager,
                        service.definition_path.display()
                    );
                }
            }
            Ok(())
        }
        Some(Commands::Setup {
            machine_name,
            command: SetupCommand::Daemon { binary },
        }) => {
            ensure_setup_machine_name(&hub_url, machine_name.as_deref()).await?;
            let installed = install_daemon_service(binary.as_deref())?;
            println!(
                "xMatrix daemon registered with {} at {}",
                installed.manager,
                installed.definition_path.display()
            );
            Ok(())
        }
        Some(Commands::List { json }) => {
            let token = resolve_auth_token(cli.token.as_deref(), &hub_url).await?;
            cmd_list(&hub_url, &token, json).await
        }
        Some(Commands::Agent { command }) => {
            let token = resolve_auth_token(cli.token.as_deref(), &hub_url).await?;
            cmd_agent(&hub_url, &token, command).await
        }
        Some(Commands::Channels { space, intake }) => {
            let token = resolve_auth_token(cli.token.as_deref(), &hub_url).await?;
            cmd_channels(&hub_url, &token, space.as_deref(), intake).await
        }
        Some(Commands::Spaces) => {
            let token = resolve_auth_token(cli.token.as_deref(), &hub_url).await?;
            cmd_spaces(&hub_url, &token).await
        }
        Some(Commands::Space { command }) => {
            let token = resolve_auth_token(cli.token.as_deref(), &hub_url).await?;
            cmd_space(&hub_url, &token, command).await
        }
        Some(Commands::Machine { command }) => cmd_machine(&hub_url, command).await,
        Some(Commands::Harness { command }) => {
            cmd_harness_cli(&hub_url, cli.token.as_deref(), command).await
        }
        Some(Commands::Workspace { command }) => {
            let token = resolve_auth_token(cli.token.as_deref(), &hub_url).await?;
            cmd_workspace(&hub_url, &token, command).await
        }
        Some(Commands::Daemon { command: None }) => {
            unreachable!("daemon host startup returns before profile admission")
        }
        Some(Commands::Daemon {
            command: Some(command),
        }) => {
            // JSON output stays parseable: no banner before it.
            if !matches!(command, DaemonCommand::WakeMetrics { json: true, .. }) {
                print_daemon_environment(&hub_url);
            }
            cmd_daemon_command(command).await
        }
        Some(Commands::Request { command }) => {
            cmd_request(&hub_url, cli.token.as_deref(), command).await
        }
        Some(Commands::Secret { command }) => {
            let token = resolve_auth_token(cli.token.as_deref(), &hub_url).await?;
            cmd_secret(&hub_url, &token, command).await
        }
        Some(Commands::Goal { command }) => cmd_goal(command),
        Some(Commands::Connector {
            command: xmatrix_cli_args::ConnectorCliCommand::Mcp,
        }) => {
            let token_override = cli.token.clone();
            crate::runtime_connector_mcp::cmd_connector_mcp(&hub_url, || {
                let hub_url = hub_url.clone();
                let token_override = token_override.clone();
                async move { resolve_auth_token(token_override.as_deref(), &hub_url).await }
            })
            .await
        }
        Some(Commands::Send(args)) => {
            let token = resolve_auth_token(cli.token.as_deref(), &hub_url).await?;
            xmatrix_cli_channel::cmd_send_args(&hub_url, &token, args).await
        }
        Some(Commands::Channel { command }) => {
            let token = resolve_auth_token(cli.token.as_deref(), &hub_url).await?;
            cmd_channel(&hub_url, &token, command).await
        }
        Some(Commands::Attachment { command }) => cmd_attachment(command).await,
        Some(Commands::Migrate { command }) => {
            cmd_migrate(&hub_url, cli.token.as_deref(), command).await
        }
        Some(Commands::Config { key, value }) => cmd_config(&hub_url, key, value).await,
        Some(Commands::Annotation { command }) => {
            let token = resolve_auth_token(cli.token.as_deref(), &hub_url).await?;
            cmd_annotation(&hub_url, &token, command).await
        }
        Some(Commands::Access { command }) => {
            let token = resolve_auth_token(cli.token.as_deref(), &hub_url).await?;
            xmatrix_cli_channel::cmd_access(&hub_url, &token, command).await
        }
        Some(Commands::Page { command }) => {
            let token = resolve_auth_token(cli.token.as_deref(), &hub_url).await?;
            cmd_page(&hub_url, &token, command).await
        }
        Some(Commands::Management { command }) => {
            let token = resolve_auth_token(cli.token.as_deref(), &hub_url).await?;
            cmd_management(&hub_url, &token, *command).await
        }
        Some(Commands::Automation { command }) => {
            let token = resolve_auth_token(cli.token.as_deref(), &hub_url).await?;
            automation::cmd_automation(&hub_url, &token, command).await
        }
        Some(Commands::External(args)) => {
            http::mark_process_as_daemon();
            cmd_external(&hub_url, cli.token.as_deref(), args).await
        }
        None => {
            use clap::CommandFactory;
            Cli::command().print_help().ok();
            println!();
            Ok(())
        }
    }
}

fn print_daemon_environment(hub_url: &str) {
    let origin = config::normalized_hub_origin(hub_url);
    let environment = if origin == DEFAULT_HUB_URL {
        "production"
    } else if origin == TEST_HUB_URL {
        "test"
    } else {
        "custom"
    };
    println!("Environment: {environment}");
    println!("Hub: {origin}");
}

async fn cmd_daemon_installation(
    legacy_hub_hint: Option<&str>,
    token_override: Option<&str>,
) -> error::Result<()> {
    #[cfg(windows)]
    if std::env::var("XMATRIX_DAEMON_PREFLIGHT").ok().as_deref() == Some("1") {
        return cmd_daemon(token_override).await;
    }

    let store = xmatrix_cli_core::profile::ProfileStore::discover();
    let registry = store.load_or_bootstrap()?;
    let context = store.context_for_default(&registry)?;
    store.prepare_context_state_root(&context)?;
    if let Some(hint) = legacy_hub_hint {
        let normalized = resolve_target_hub_choice(None, Some(hint), "production")?;
        if normalized != context.hub_origin {
            eprintln!(
                "{} ignoring legacy daemon Hub hint {}; registry default {} is authoritative",
                "⚠".yellow().bold(),
                normalized,
                context.hub_origin
            );
        }
    }
    print_daemon_environment(&context.hub_origin);
    #[cfg(unix)]
    if let Err(error) = crate::runtime_daemon_fd_limit::raise_daemon_open_file_limit() {
        eprintln!(
            "{} daemon keeps its open-file limit: {error}",
            "⚠".yellow().bold()
        );
    }
    cmd_daemon(token_override).await
}

async fn resolve_target_profile(
    profile_selector: Option<&str>,
    environment: Option<CliEnvironmentArg>,
    hub_url: Option<&str>,
) -> error::Result<(String, xmatrix_cli_core::profile::ProfileContext)> {
    let store = xmatrix_cli_core::profile::ProfileStore::discover();
    let mut registry = store.load_or_bootstrap()?;
    let context = if let Some(selector) = profile_selector {
        store.context_for_selector(&registry, selector, false)?
    } else if let Some(environment) = environment {
        let selector = environment.as_str();
        match store.context_for_selector(&registry, selector, false) {
            Ok(context) => context,
            Err(_)
                if !registry.profiles.iter().any(|profile| {
                    profile.is_selectable() && profile.name.eq_ignore_ascii_case(selector)
                }) =>
            {
                let hub_url = if environment == CliEnvironmentArg::Test {
                    TEST_HUB_URL
                } else {
                    DEFAULT_HUB_URL
                };
                registry = store.create(registry.revision, selector, hub_url, true)?;
                store.context_for_selector(&registry, selector, false)?
            }
            Err(error) => return Err(error),
        }
    } else {
        store.context_for_default(&registry)?
    };
    let selected_hub = if let Some(hub_url) = hub_url {
        resolve_target_hub_choice(None, Some(hub_url), "production")?
    } else {
        context.hub_origin.clone()
    };
    Ok((selected_hub, context))
}

fn resolve_target_hub_choice(
    environment: Option<CliEnvironmentArg>,
    hub_url: Option<&str>,
    active_environment: &str,
) -> error::Result<String> {
    if environment.is_some() && hub_url.is_some() {
        return Err(CliError::Auth(
            "`--environment` and `--hub-url` cannot be used together".into(),
        ));
    }
    if let Some(hub_url) = hub_url {
        return http::normalize_hub_origin(
            hub_url,
            "Hub URL must be an absolute HTTP(S) URL",
            "Hub URL must be an absolute HTTP(S) origin without credentials, query, or fragment",
        );
    }
    let environment = environment
        .map(|environment| environment.as_str().to_string())
        .unwrap_or_else(|| active_environment.to_string());
    Ok(match environment.as_str() {
        "test" => TEST_HUB_URL.to_string(),
        _ => DEFAULT_HUB_URL.to_string(),
    })
}

async fn cmd_profile(command: ProfileCommand) -> error::Result<()> {
    use xmatrix_cli_core::profile::ProfileStore;

    let store = ProfileStore::discover();
    match command {
        ProfileCommand::List { json } => {
            let registry = store.load_or_bootstrap()?;
            let daemon_state =
                xmatrix_cli_core::daemon_host::daemon_host_status(store.installation())
                    .await?
                    .into_available();
            let applied_revision = daemon_state
                .as_ref()
                .map(|state| state.loaded_registry_revision);
            let profiles = registry
                .profiles
                .iter()
                .filter(|profile| profile.is_selectable())
                .map(|profile| {
                    serde_json::json!({
                        "id": profile.id,
                        "name": profile.name,
                        "hubUrl": profile.hub_url,
                        "enabled": profile.enabled,
                        "stateKind": profile.state_kind,
                        "default": profile.id == registry.default_profile_id,
                        "runtimeState": if !profile.enabled {
                            "disabled"
                        } else {
                            daemon_state
                                .as_ref()
                                .and_then(|state| state.profiles.iter().find(|runtime| runtime.profile_id == profile.id))
                                .map(|runtime| runtime.lifecycle.as_str())
                                .unwrap_or("not-started")
                        },
                    })
                })
                .collect::<Vec<_>>();
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "schemaVersion": registry.schema_version,
                        "revision": registry.revision,
                        "defaultProfileId": registry.default_profile_id,
                        "daemonAppliedRevision": applied_revision,
                        "profiles": profiles,
                    }))?
                );
            } else {
                for profile in &profiles {
                    let marker = if profile["default"].as_bool() == Some(true) {
                        "*"
                    } else {
                        " "
                    };
                    println!(
                        "{marker} {:<20} {:<9} {}  {}",
                        profile["name"].as_str().unwrap_or_default(),
                        if profile["enabled"].as_bool() == Some(true) {
                            "enabled"
                        } else {
                            "disabled"
                        },
                        profile["hubUrl"].as_str().unwrap_or_default(),
                        profile["id"].as_str().unwrap_or_default(),
                    );
                }
            }
            Ok(())
        }
        ProfileCommand::Current { json } => {
            let registry = store.load_or_bootstrap()?;
            let context = store.context_for_default(&registry)?;
            let daemon_state =
                xmatrix_cli_core::daemon_host::daemon_host_status(store.installation())
                    .await?
                    .into_available();
            let applied_revision = daemon_state
                .as_ref()
                .map(|state| state.loaded_registry_revision);
            let runtime_state = daemon_state.as_ref().and_then(|state| {
                state
                    .profiles
                    .iter()
                    .find(|profile| profile.profile_id == context.id)
                    .map(|runtime| runtime.lifecycle.as_str())
            });
            let pending = !daemon_state.as_ref().is_some_and(|state| {
                state.loaded_registry_revision == registry.revision
                    && state.default_profile_id == registry.default_profile_id
            });
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "id": context.id,
                        "name": context.name,
                        "hubUrl": context.hub_origin,
                        "registryRevision": registry.revision,
                        "daemonAppliedRevision": applied_revision,
                        "liveSwitchPending": pending,
                        "runtimeState": runtime_state,
                    }))?
                );
            } else {
                println!("Profile: {}", context.name);
                println!("ID: {}", context.id);
                println!("Hub: {}", context.hub_origin);
                println!("Registry revision: {}", registry.revision);
                println!(
                    "Daemon applied revision: {}",
                    applied_revision
                        .map(|revision| revision.to_string())
                        .unwrap_or_else(|| "unavailable".to_string())
                );
                println!("Runtime state: {}", runtime_state.unwrap_or("unavailable"));
                if pending {
                    println!("Status: live switch pending");
                }
            }
            Ok(())
        }
        ProfileCommand::Create {
            name,
            hub_url,
            disabled,
        } => {
            let registry = store.load_or_bootstrap()?;
            let updated = store.create(registry.revision, &name, &hub_url, !disabled)?;
            let context = store.context_for_selector(&updated, &name, true)?;
            println!("{} created profile {}", "✓".green().bold(), context.name);
            println!("  ID: {}", context.id);
            println!("  Hub: {}", context.hub_origin);
            reconcile_profile_mutation(&store, updated.revision).await?;
            Ok(())
        }
        ProfileCommand::Show { name, json } => {
            let registry = store.load_or_bootstrap()?;
            let context = store.context_for_selector(&registry, &name, true)?;
            let profile = registry
                .profiles
                .iter()
                .find(|profile| profile.id == context.id)
                .expect("resolved profile remains present");
            if json {
                println!("{}", serde_json::to_string_pretty(profile)?);
            } else {
                println!("Profile: {}", profile.name);
                println!("ID: {}", profile.id);
                println!("Hub: {}", profile.hub_url);
                println!("Enabled: {}", profile.enabled);
                println!("State: {:?}", profile.state_kind);
                println!("Default: {}", profile.id == registry.default_profile_id);
                println!("Registry revision: {}", registry.revision);
            }
            Ok(())
        }
        ProfileCommand::Use { name } => {
            let registry = store.load_or_bootstrap()?;
            let before = registry.revision;
            let updated = store.set_default(before, &name)?;
            let context = store.context_for_default(&updated)?;
            report_default_profile_apply(
                &store,
                &context,
                updated.revision,
                updated.revision == before,
            )
            .await
        }
        ProfileCommand::Rename { old, new } => {
            let registry = store.load_or_bootstrap()?;
            let updated = store.rename(registry.revision, &old, &new)?;
            let context = store.context_for_selector(&updated, &new, true)?;
            println!(
                "{} renamed profile to {} ({})",
                "✓".green().bold(),
                context.name,
                context.id
            );
            reconcile_profile_mutation(&store, updated.revision).await?;
            Ok(())
        }
        ProfileCommand::Enable { name } => {
            let registry = store.load_or_bootstrap()?;
            let updated = store.set_enabled(registry.revision, &name, true)?;
            let context = store.context_for_selector(&updated, &name, true)?;
            println!("{} enabled profile {}", "✓".green().bold(), context.name);
            reconcile_profile_mutation(&store, updated.revision).await?;
            Ok(())
        }
        ProfileCommand::Disable { name } => {
            let registry = store.load_or_bootstrap()?;
            let updated = store.set_enabled(registry.revision, &name, false)?;
            let context = store.context_for_selector(&updated, &name, true)?;
            println!("{} disabled profile {}", "✓".green().bold(), context.name);
            reconcile_profile_mutation(&store, updated.revision).await?;
            Ok(())
        }
        ProfileCommand::Remove { name } => {
            let registry = store.load_or_bootstrap()?;
            let context = store.context_for_selector(&registry, &name, true)?;
            let id = context.id.clone();
            let live_host_status = stop_profile_for_retirement(&store, &id).await?;
            let updated = store.remove_with_host_status(
                registry.revision,
                &name,
                live_host_status.as_ref(),
            )?;
            println!(
                "{} removed profile {} ({id}); local state is retained",
                "✓".green().bold(),
                context.name
            );
            reconcile_profile_mutation(&store, updated.revision).await?;
            Ok(())
        }
        ProfileCommand::Purge { name_or_id, yes } => {
            if !yes {
                return Err(CliError::Auth(
                    "Profile purge is permanent; pass `--yes` to confirm".into(),
                ));
            }
            let registry = store.load_or_bootstrap()?;
            let live_host_status =
                xmatrix_cli_core::daemon_host::daemon_host_status(store.installation())
                    .await?
                    .into_available();
            let updated = store.purge_with_host_status(
                registry.revision,
                &name_or_id,
                live_host_status.as_ref(),
            )?;
            println!(
                "{} purged exact profile state for {} at registry revision {}",
                "✓".green().bold(),
                name_or_id,
                updated.revision
            );
            reconcile_profile_mutation(&store, updated.revision).await?;
            Ok(())
        }
    }
}

async fn stop_profile_for_retirement(
    store: &xmatrix_cli_core::profile::ProfileStore,
    profile_id: &xmatrix_cli_core::profile::ProfileId,
) -> error::Result<Option<xmatrix_cli_core::daemon_host::DaemonHostStatus>> {
    use xmatrix_cli_core::daemon_host::{DaemonHostQueryOutcome, ProfileControlAction};

    match xmatrix_cli_core::daemon_host::daemon_profile_control(
        store.installation(),
        ProfileControlAction::Stop,
        profile_id,
    )
    .await?
    {
        DaemonHostQueryOutcome::Unavailable | DaemonHostQueryOutcome::Unsupported => {
            return Ok(None);
        }
        DaemonHostQueryOutcome::Available(_) => {}
    }
    for _ in 0..40 {
        tokio::time::sleep(Duration::from_millis(125)).await;
        match xmatrix_cli_core::daemon_host::daemon_host_status(store.installation()).await? {
            DaemonHostQueryOutcome::Available(status)
                if status
                    .profiles
                    .iter()
                    .find(|profile| &profile.profile_id == profile_id)
                    .is_none_or(|profile| profile.lifecycle == "disabled") =>
            {
                return Ok(Some(status));
            }
            DaemonHostQueryOutcome::Unavailable | DaemonHostQueryOutcome::Unsupported => {
                return Ok(None);
            }
            DaemonHostQueryOutcome::Available(_) => {}
        }
    }
    Err(CliError::Launch(format!(
        "Timed out waiting for profile {profile_id} runtime to stop"
    )))
}

async fn report_default_profile_apply(
    store: &xmatrix_cli_core::profile::ProfileStore,
    context: &xmatrix_cli_core::profile::ProfileContext,
    revision: u64,
    already_default: bool,
) -> error::Result<()> {
    use xmatrix_cli_core::daemon_host::ApplyDefaultRevisionOutcome;

    let mut outcome =
        xmatrix_cli_core::daemon_host::apply_default_revision(store.installation(), revision)
            .await?;
    if matches!(outcome, ApplyDefaultRevisionOutcome::Unavailable)
        && request_os_managed_daemon_start()
    {
        for _ in 0..20 {
            tokio::time::sleep(Duration::from_millis(250)).await;
            outcome = xmatrix_cli_core::daemon_host::apply_default_revision(
                store.installation(),
                revision,
            )
            .await?;
            if !matches!(outcome, ApplyDefaultRevisionOutcome::Unavailable) {
                break;
            }
        }
    }
    match outcome {
        ApplyDefaultRevisionOutcome::Applied(response) => {
            println!(
                "{} default profile {} is live at revision {}",
                "✓".green().bold(),
                context.name,
                response.applied_revision
            );
            Ok(())
        }
        ApplyDefaultRevisionOutcome::Pending(response) => {
            println!(
                "{} {}",
                "✓".green().bold(),
                if already_default {
                    format!("{} remains the persistent default profile", context.name)
                } else {
                    format!("default profile is now {}", context.name)
                }
            );
            println!(
                "  Persistent revision {} committed; live switch pending (runtime: {})",
                revision,
                response.runtime_state.as_deref().unwrap_or("unknown")
            );
            Ok(())
        }
        ApplyDefaultRevisionOutcome::Superseded(response) => Err(CliError::Launch(format!(
            "Default switch revision {revision} was superseded by revision {} for profile {}",
            response.applied_revision, response.default_profile_id
        ))),
        ApplyDefaultRevisionOutcome::Unavailable => {
            println!(
                "{} {}",
                "✓".green().bold(),
                if already_default {
                    format!("{} remains the persistent default profile", context.name)
                } else {
                    format!("default profile is now {}", context.name)
                }
            );
            println!(
                "  Persistent revision {revision} committed; live switch pending (DaemonHost unavailable)"
            );
            Ok(())
        }
        ApplyDefaultRevisionOutcome::Unsupported => {
            println!(
                "{} default profile is now {}",
                "✓".green().bold(),
                context.name
            );
            println!(
                "  Persistent revision {revision} committed; live switch pending (running daemon needs an update)"
            );
            Ok(())
        }
    }
}

fn request_os_managed_daemon_start() -> bool {
    #[cfg(target_os = "macos")]
    {
        let uid = unsafe { libc::getuid() };
        xmatrix_cli_update::quiet_service_status(
            "launchctl",
            &["kickstart", &format!("gui/{uid}/sh.xmatrix.daemon")],
        )
    }
    #[cfg(target_os = "linux")]
    {
        xmatrix_cli_update::quiet_service_status(
            "systemctl",
            &["--user", "start", "xmatrix-daemon.service"],
        )
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let Ok(executable) = std::env::current_exe() else {
            return false;
        };
        return std::process::Command::new(executable)
            .args(["machine", "supervisor", "start-daemon"])
            .env_remove("XMATRIX_PROFILE")
            .env_remove("XMATRIX_ENVIRONMENT")
            .env_remove("XMATRIX_HUB_URL")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .is_ok();
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    false
}

async fn reconcile_profile_mutation(
    store: &xmatrix_cli_core::profile::ProfileStore,
    revision: u64,
) -> error::Result<()> {
    use xmatrix_cli_core::daemon_host::DaemonHostQueryOutcome;

    match xmatrix_cli_core::daemon_host::reconcile_daemon_host(store.installation()).await? {
        DaemonHostQueryOutcome::Available(response) if response.applied_revision < revision => {
            Err(CliError::Launch(format!(
                "Daemon host reconciled registry revision {}, older than committed revision {revision}",
                response.applied_revision
            )))
        }
        DaemonHostQueryOutcome::Available(_)
        | DaemonHostQueryOutcome::Unavailable
        | DaemonHostQueryOutcome::Unsupported => Ok(()),
    }
}

async fn cmd_environment(command: EnvironmentCommand) -> error::Result<()> {
    if let Some(hub) = config::agent_cli_hub() {
        if !matches!(command, EnvironmentCommand::Current) {
            return Err(CliError::Auth(
                "Agent commands cannot inspect or change installation environments".into(),
            ));
        }
        print_daemon_environment(hub);
        return Ok(());
    }
    let store = xmatrix_cli_core::profile::ProfileStore::discover();
    match command {
        EnvironmentCommand::List => {
            let registry = store.load_or_bootstrap()?;
            for (name, hub) in [("production", DEFAULT_HUB_URL), ("test", TEST_HUB_URL)] {
                let profile = registry.profiles.iter().find(|profile| {
                    profile.is_selectable() && profile.name.eq_ignore_ascii_case(name)
                });
                let marker =
                    if profile.is_some_and(|profile| profile.id == registry.default_profile_id) {
                        "*"
                    } else {
                        " "
                    };
                let status = match profile {
                    Some(profile) if profile.enabled => "enabled",
                    Some(_) => "disabled",
                    None => "not created",
                };
                println!("{marker} {name:<10} {hub} ({status})");
            }
            Ok(())
        }
        EnvironmentCommand::Current => {
            let registry = store.load_or_bootstrap()?;
            let context = store.context_for_default(&registry)?;
            println!("Environment: {}", context.name);
            println!("Hub: {}", context.hub_origin);
            println!("Profile ID: {}", context.id);
            Ok(())
        }
        EnvironmentCommand::Use { environment } => {
            if env_flag("XMATRIX_HEADLESS") || env_flag("XMATRIX_AGENT_SESSION") {
                return Err(CliError::Auth(
                    "Agent runs cannot change the installation default profile".into(),
                ));
            }
            let target = environment.as_str();
            let hub = if target == "test" {
                TEST_HUB_URL
            } else {
                DEFAULT_HUB_URL
            };
            let mut registry = store.load_or_bootstrap()?;
            if store.context_for_selector(&registry, target, true).is_err() {
                registry = store.create(registry.revision, target, hub, true)?;
            }
            let before = registry.revision;
            let updated = store.set_default(before, target)?;
            let context = store.context_for_default(&updated)?;
            report_default_profile_apply(
                &store,
                &context,
                updated.revision,
                updated.revision == before,
            )
            .await
        }
    }
}

/// A variable's trimmed value, or `None` when it is unset or blank.
use xmatrix_cli_core::config::non_empty_env;

fn env_flag(name: &str) -> bool {
    matches!(
        std::env::var(name),
        Ok(value) if matches!(value.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on")
    )
}

fn validate_agent_profile_lineage(
    agent_runtime: bool,
    pinned_profile_id: Option<&str>,
    selected_profile_id: &xmatrix_cli_core::profile::ProfileId,
    selected_state_kind: xmatrix_cli_core::profile::ProfileStateKind,
) -> error::Result<()> {
    if !agent_runtime {
        return Ok(());
    }
    let Some(pinned_profile_id) = pinned_profile_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        // Historical wrappers have no profile lineage. They remain valid only
        // while the migrated legacy-root runtime is the admitted profile.
        if selected_state_kind != xmatrix_cli_core::profile::ProfileStateKind::LegacyRoot {
            return Err(CliError::Auth(
                "Agent run has no profile lineage for an isolated profile".into(),
            ));
        }
        return Ok(());
    };
    let pinned = xmatrix_cli_core::profile::ProfileId::parse(pinned_profile_id)?;
    if &pinned != selected_profile_id {
        return Err(CliError::Auth(format!(
            "Agent run is pinned to profile {pinned}, refusing selected sibling profile {selected_profile_id}"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod profile_admission_tests {
    use super::{
        ProfileCompletionDisposition, ProfileManager, ProfileRuntimeExit,
        collect_run_recovery_sidecars, persisted_profile_lineage_matches,
        profile_completion_disposition, seal_daemon_host_update_recovery, select_update_authority,
        validate_agent_profile_lineage,
    };
    use std::collections::HashSet;
    use xmatrix_cli_core::profile::{InstallationRoot, ProfileId, ProfileStore};

    #[test]
    fn agent_profile_lineage_allows_exact_match_and_rejects_sibling() {
        let selected = ProfileId::parse("profile:00000000-0000-0000-0000-000000000001").unwrap();
        assert!(
            validate_agent_profile_lineage(
                true,
                Some("profile:00000000-0000-0000-0000-000000000001"),
                &selected,
                xmatrix_cli_core::profile::ProfileStateKind::Isolated,
            )
            .is_ok()
        );
        assert!(
            validate_agent_profile_lineage(
                true,
                Some("profile:00000000-0000-0000-0000-000000000002"),
                &selected,
                xmatrix_cli_core::profile::ProfileStateKind::Isolated,
            )
            .unwrap_err()
            .to_string()
            .contains("sibling profile")
        );
        assert!(
            validate_agent_profile_lineage(
                true,
                None,
                &selected,
                xmatrix_cli_core::profile::ProfileStateKind::Isolated,
            )
            .unwrap_err()
            .to_string()
            .contains("no profile lineage")
        );
    }

    #[test]
    fn ordinary_shell_does_not_trust_or_require_run_lineage() {
        let selected = ProfileId::parse("profile:00000000-0000-0000-0000-000000000001").unwrap();
        assert!(
            validate_agent_profile_lineage(
                false,
                Some("malformed"),
                &selected,
                xmatrix_cli_core::profile::ProfileStateKind::Isolated,
            )
            .is_ok()
        );
    }

    #[test]
    fn persisted_run_lineage_allows_legacy_only_without_an_id() {
        let root = std::env::temp_dir().join(format!(
            "xmatrix-runtime-profile-lineage-{}",
            uuid::Uuid::new_v4()
        ));
        let store = ProfileStore::new(InstallationRoot::new(root.clone()));
        let registry = store.load_or_bootstrap().unwrap();
        let legacy = store.context_for_default(&registry).unwrap();
        let created = store
            .create(registry.revision, "isolated", "https://example.com", true)
            .unwrap();
        let isolated = store
            .context_for_selector(&created, "isolated", false)
            .unwrap();

        assert!(persisted_profile_lineage_matches(None, Some(&legacy)));
        assert!(!persisted_profile_lineage_matches(None, Some(&isolated)));
        assert!(persisted_profile_lineage_matches(
            Some(isolated.id.as_str()),
            Some(&isolated),
        ));
        assert!(!persisted_profile_lineage_matches(
            Some(legacy.id.as_str()),
            Some(&isolated),
        ));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn update_recovery_seal_covers_every_enabled_profile_by_immutable_id() {
        let root = std::env::temp_dir().join(format!(
            "xmatrix-runtime-update-seal-{}",
            uuid::Uuid::new_v4()
        ));
        let installation = InstallationRoot::new(root.clone());
        let store = ProfileStore::new(installation.clone());
        let initial = store.load_or_bootstrap().unwrap();
        let registry = store
            .create(initial.revision, "isolated", "https://example.com", true)
            .unwrap();
        let isolated = store
            .context_for_selector(&registry, "isolated", false)
            .unwrap();
        store.prepare_context_state_root(&isolated).unwrap();
        std::fs::write(
            isolated.state_root.join("config.json"),
            r#"{"machineId":"machine:isolated"}"#,
        )
        .unwrap();
        std::fs::write(isolated.state_root.join("daemon-run-registry.json"), "[]").unwrap();
        let manager = ProfileManager::load(installation).unwrap();

        seal_daemon_host_update_recovery(&manager).unwrap();
        let value: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(root.join("daemon-host/update-recovery.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(value["registryRevision"], registry.revision);
        assert!(value["profiles"].as_array().unwrap().iter().any(|profile| {
            profile["profileId"] == isolated.id.as_str()
                && profile["machineId"] == "machine:isolated"
                && profile["runRegistry"]["sha256"]
                    .as_str()
                    .is_some_and(|digest| digest.len() == 64)
        }));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn stopped_update_authority_is_replaced_when_a_profile_is_available() {
        let root = std::env::temp_dir().join(format!(
            "xmatrix-runtime-update-authority-{}",
            uuid::Uuid::new_v4()
        ));
        let store = ProfileStore::new(InstallationRoot::new(root.clone()));
        let initial = store.load_or_bootstrap().unwrap();
        let current = initial.default_profile_id.clone();
        let registry = store
            .create(initial.revision, "second", "https://example.com", true)
            .unwrap();
        let second = store
            .context_for_selector(&registry, "second", false)
            .unwrap()
            .id;
        let mut stopped = HashSet::from([current.clone()]);
        let running = HashSet::from([second.clone()]);

        assert_eq!(
            select_update_authority(&registry, &stopped, &running, &current),
            Some(second.clone())
        );
        stopped.clear();
        assert_eq!(
            select_update_authority(&registry, &stopped, &running, &current),
            Some(second.clone())
        );
        stopped.insert(current.clone());
        stopped.insert(second);
        assert_eq!(
            select_update_authority(&registry, &stopped, &running, &current),
            None
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn only_update_handoff_exits_the_shared_daemon_host() {
        assert_eq!(
            profile_completion_disposition(&Ok(ProfileRuntimeExit::UpdateHandoff)),
            ProfileCompletionDisposition::ExitHost
        );
        assert_eq!(
            profile_completion_disposition(&Ok(ProfileRuntimeExit::HubShutdown(None))),
            ProfileCompletionDisposition::DisableProfile
        );
        assert_eq!(
            profile_completion_disposition(&Err("connection ended".into())),
            ProfileCompletionDisposition::ContinueSupervision
        );
    }

    #[test]
    fn update_recovery_scan_bounds_all_directory_entries() {
        let root = std::env::temp_dir().join(format!(
            "xmatrix-runtime-update-entry-bound-{}",
            uuid::Uuid::new_v4()
        ));
        let runs_root = root.join("runs");
        std::fs::create_dir_all(&runs_root).unwrap();
        for name in ["one.log", "two.log", "three.log"] {
            std::fs::write(runs_root.join(name), "ignored").unwrap();
        }
        let profile_id = ProfileId::parse("profile:00000000-0000-0000-0000-000000000001").unwrap();

        let error = collect_run_recovery_sidecars(&runs_root, &profile_id, 1024, 2, 10)
            .unwrap_err()
            .to_string();
        assert!(error.contains("Too many Run recovery directory entries"));
        let _ = std::fs::remove_dir_all(root);
    }
}

fn daemon_spawn_cwd_from_values(headless: bool, spawn_cwd: Option<&str>) -> Option<PathBuf> {
    if !headless {
        return None;
    }
    spawn_cwd
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
}

fn daemon_spawn_cwd_from_env() -> Option<PathBuf> {
    daemon_spawn_cwd_from_values(
        env_flag("XMATRIX_HEADLESS"),
        std::env::var("XMATRIX_SPAWN_CWD").ok().as_deref(),
    )
}

fn headless_identity_runtime_mismatch_from_values(
    headless: bool,
    identity_override: Option<&str>,
    tool: &str,
    expected_runtime: Option<&str>,
) -> bool {
    if !headless {
        return false;
    }
    if identity_override
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_none()
    {
        return false;
    }
    let Some(expected_runtime) = expected_runtime
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return false;
    };
    // A registration may name its runtime by absolute path; compare the
    // executable names on both sides, as the wrapper only sees `tool`'s.
    !runtime_executable_name(tool).eq_ignore_ascii_case(runtime_executable_name(expected_runtime))
}

fn runtime_executable_name(runtime: &str) -> &str {
    let name = runtime.rsplit(['/', '\\']).next().unwrap_or(runtime);
    name.len()
        .checked_sub(4)
        .filter(|&stem| name.is_char_boundary(stem) && name[stem..].eq_ignore_ascii_case(".exe"))
        .map_or(name, |stem| &name[..stem])
}

/// An unknown subcommand inside a Run reaches `Commands::External`, which
/// would start a runtime under the inherited Run identity. Only the Run's own
/// runtime may do that; anything else is a nested command this CLI lacks
/// (typically a stale `xmatrix` found on PATH before the daemon's).
fn nested_external_command_refusal(args: &[String]) -> Option<CliError> {
    let cmd = args.first()?;
    let tool = cmd.rsplit('/').next().unwrap_or(cmd);
    let expected = std::env::var("XMATRIX_SPAWN_RUNTIME").ok();
    if !headless_identity_runtime_mismatch(tool, expected.as_deref()) {
        return None;
    }
    let this_cli = std::env::current_exe()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|_| "xmatrix".into());
    let run_cli = std::env::var(xmatrix_cli_agent::XMATRIX_BIN_ENV)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(|bin| format!("; run it with this Run's CLI: {bin} {cmd}"))
        .unwrap_or_default();
    Some(CliError::Launch(format!(
        "Refusing to register inherited agent identity for nested xmatrix runtime '{tool}'; expected '{}'. \
         `{cmd}` is not a command of {this_cli} ({}){run_cli}",
        expected.unwrap_or_default(),
        xmatrix_cli_core::version::current(),
    )))
}

fn headless_identity_runtime_mismatch(tool: &str, expected_runtime: Option<&str>) -> bool {
    headless_identity_runtime_mismatch_from_values(
        env_flag("XMATRIX_HEADLESS"),
        std::env::var("XMATRIX_AGENT_IDENTITY_ID_OVERRIDE")
            .ok()
            .as_deref(),
        tool,
        expected_runtime,
    )
}

fn prepare_headless_spawn_cwd() -> error::Result<Option<PathBuf>> {
    if !env_flag("XMATRIX_HEADLESS") {
        return Ok(None);
    }
    let raw_spawn_cwd = non_empty_env("XMATRIX_SPAWN_CWD");
    let Some(spawn_cwd) = daemon_spawn_cwd_from_values(true, raw_spawn_cwd.as_deref()) else {
        if raw_spawn_cwd.is_some() {
            return Err(CliError::Launch(format!(
                "Invalid daemon spawn cwd: XMATRIX_SPAWN_CWD must be an absolute path, got {}",
                raw_spawn_cwd.unwrap_or_default()
            )));
        }
        return Ok(None);
    };

    let metadata = std::fs::metadata(&spawn_cwd).map_err(|err| {
        CliError::Launch(format!(
            "Failed to inspect daemon spawn cwd {}: {err}",
            spawn_cwd.display()
        ))
    })?;
    if !metadata.is_dir() {
        return Err(CliError::Launch(format!(
            "Daemon spawn cwd is not a directory: {}",
            spawn_cwd.display()
        )));
    }
    std::env::set_current_dir(&spawn_cwd).map_err(|err| {
        CliError::Launch(format!(
            "Failed to enter daemon spawn cwd {}: {err}",
            spawn_cwd.display()
        ))
    })?;
    Ok(Some(spawn_cwd))
}

fn external_registration_cwd(prepared_spawn_cwd: Option<&Path>) -> Option<PathBuf> {
    prepared_spawn_cwd
        .map(Path::to_path_buf)
        .or_else(daemon_spawn_cwd_from_env)
        .or_else(|| std::env::current_dir().ok())
}

async fn cmd_attachment(command: AttachmentCommand) -> error::Result<()> {
    match command {
        AttachmentCommand::Fetch { url, output } => {
            let path = fetch_channel_image_reference(&url, output.as_deref()).await?;
            println!("{}", path.to_string_lossy());
            Ok(())
        }
    }
}

async fn cmd_management(
    hub_url: &str,
    token: &str,
    mut command: ManagementCommand,
) -> error::Result<()> {
    let space = command.space_mut();
    *space = xmatrix_cli_core::space_ref::resolve_space_ref(hub_url, token, space).await?;
    match command {
        ManagementCommand::Channels {
            space,
            query,
            limit,
            json,
        } => cmd_management_channels(hub_url, token, &space, &query, limit, json).await,
        ManagementCommand::Channel {
            space,
            channel,
            message_limit,
            json,
        } => cmd_management_channel(hub_url, token, &space, &channel, message_limit, json).await,
    }
}

async fn cmd_management_channels(
    hub_url: &str,
    token: &str,
    space_id: &str,
    query: &str,
    limit: u32,
    json_output: bool,
) -> error::Result<()> {
    let response: Value = http::request_json(
        &with_route(
            hub_url,
            &protocol::space_management_channels_route(space_id, query, limit.clamp(1, 200)),
        ),
        "GET",
        Some(token),
        None,
    )
    .await?;
    if json_output {
        println!("{}", serde_json::to_string_pretty(&response)?);
        return Ok(());
    }
    let matches = response["matches"].as_array().cloned().unwrap_or_default();
    println!(
        "Management channel search in {}: {} matches{}",
        space_id,
        matches.len(),
        if response["truncated"].as_bool() == Some(true) {
            " (truncated)"
        } else {
            ""
        }
    );
    for item in matches {
        let channel = &item["detail"]["channel"];
        println!(
            "- {} ({}) fields={}",
            channel["name"].as_str().unwrap_or("unnamed"),
            channel["id"].as_str().unwrap_or("unknown"),
            item["matchedFields"]
                .as_array()
                .map(|fields| fields
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(","))
                .unwrap_or_default()
        );
    }
    Ok(())
}

async fn cmd_management_channel(
    hub_url: &str,
    token: &str,
    space_id: &str,
    channel_id: &str,
    message_limit: u32,
    json_output: bool,
) -> error::Result<()> {
    let response: Value = http::request_json(
        &with_route(
            hub_url,
            &protocol::space_management_channel_route(
                space_id,
                channel_id,
                message_limit.clamp(1, 100),
            ),
        ),
        "GET",
        Some(token),
        None,
    )
    .await?;
    if json_output {
        println!("{}", serde_json::to_string_pretty(&response)?);
        return Ok(());
    }
    let detail = &response["detail"];
    let channel = &detail["channel"];
    println!(
        "{} ({}) mode={} archived={} frozen={} runs={} loops={} claims={} bindings={} failures={}",
        channel["name"].as_str().unwrap_or("unnamed"),
        channel["id"].as_str().unwrap_or(channel_id),
        channel["mode"].as_str().unwrap_or("unknown"),
        detail["archived"].as_bool().unwrap_or(false),
        detail["frozen"].as_bool().unwrap_or(false),
        detail["liveRunIds"]
            .as_array()
            .map(Vec::len)
            .unwrap_or_default(),
        detail["openLoops"]
            .as_array()
            .map(Vec::len)
            .unwrap_or_default(),
        detail["claims"]
            .as_array()
            .map(Vec::len)
            .unwrap_or_default(),
        detail["bindings"]
            .as_array()
            .map(Vec::len)
            .unwrap_or_default(),
        detail["recentFailures"]
            .as_array()
            .map(Vec::len)
            .unwrap_or_default(),
    );
    Ok(())
}

async fn ensure_setup_machine_name(hub_url: &str, name: Option<&str>) -> error::Result<()> {
    // Installing a service before login creates no Machine. Its enrollment is
    // separately guarded; once signed in, setup must resolve the required name.
    if let Some(session) = config::load_session_for_hub(hub_url).await {
        xmatrix_cli_core::machine_naming::ensure_machine_name(&session, name, None).await?;
    }
    Ok(())
}
