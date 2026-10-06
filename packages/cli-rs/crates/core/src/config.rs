use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::error::{CliError, Result};
use crate::hex::sha256_hex;
use crate::human_connection::derive_connection_url as derive_human_connection_url;
use crate::profile::ProfileContext;
use crate::protocol::{AuthUser, DEFAULT_HUB_URL, TEST_HUB_URL, normalize_hub_url};

/// A configured text value, with surrounding whitespace removed and blanks absent.
pub fn non_empty_env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// The bounded opaque key used by management workspace producers and consumers.
pub fn normalized_management_workspace_key(value: &str) -> Option<&str> {
    let value = value.trim();
    (!value.is_empty()
        && value.len() <= 128
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | ':')
        }))
    .then_some(value)
}

const MACHINE_ID_PREFIX: &str = "machine:";
pub const SESSION_MAX_AGE_SECS: u64 = 7 * 24 * 60 * 60;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliSession {
    pub token: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub refresh_token: Option<String>,
    pub user: AuthUser,
    pub hub_url: String,
    pub relay_url: String,
    pub updated_at: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MachineFingerprint {
    pub source: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreviousMachineId {
    pub machine_id: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub machine_fingerprint: Option<MachineFingerprint>,
    pub rotated_at: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MachineIdentity {
    pub machine_id: String,
    pub fingerprint: MachineFingerprint,
    /// Minted ids this config directory used before; see `legacy_machine_ids`.
    pub legacy_machine_ids: Vec<String>,
    /// For a WSL distribution, the Machine id of its Windows host.
    pub parent_machine_id: Option<String>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct CliConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<CliSession>,
    #[serde(rename = "machineId", skip_serializing_if = "Option::is_none")]
    pub machine_id: Option<String>,
    #[serde(
        rename = "machineFingerprint",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub machine_fingerprint: Option<MachineFingerprint>,
    #[serde(
        rename = "previousMachineIds",
        skip_serializing_if = "Vec::is_empty",
        default
    )]
    pub previous_machine_ids: Vec<PreviousMachineId>,
    /// Last-resort host identity for a host that exposes none.
    #[serde(
        rename = "machineSeed",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub machine_seed: Option<String>,
    #[serde(
        rename = "activeEnvironment",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub active_environment: Option<String>,
    #[serde(
        rename = "cloudflaredPath",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub cloudflared_path: Option<String>,
}

pub fn config_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("XMATRIX_CONFIG_DIR") {
        let trimmed = dir.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".config")
        .join("xmatrix")
}

static PROCESS_PROFILE_CONTEXT: std::sync::OnceLock<ProfileContext> = std::sync::OnceLock::new();
// Agent child commands route through their inherited Run brokers, not the Human
// installation registry. This is routing only, never a credential or grant.
static PROCESS_AGENT_CLI_HUB: std::sync::OnceLock<String> = std::sync::OnceLock::new();

pub fn install_agent_cli_hub(hub: String) -> Result<()> {
    if PROCESS_PROFILE_CONTEXT.get().is_some() {
        return Err(CliError::Auth(
            "Human profile context is already installed".into(),
        ));
    }
    match PROCESS_AGENT_CLI_HUB.get() {
        Some(current) if current == &hub => Ok(()),
        Some(_) => Err(CliError::Auth("Agent command Hub is already fixed".into())),
        None => PROCESS_AGENT_CLI_HUB
            .set(hub)
            .map_err(|_| CliError::Auth("Failed to fix Agent command Hub".into())),
    }
}

pub fn agent_cli_hub() -> Option<&'static str> {
    PROCESS_AGENT_CLI_HUB.get().map(String::as_str)
}

tokio::task_local! {
    static TASK_PROFILE_CONTEXT: ProfileContext;
    static TASK_PROFILE_TASKS: ProfileTaskSet;
}

/// Every task a Profile actor spawned, so the actor can take them down with it.
///
/// `tokio::spawn` detaches. A Profile runtime that returned (restart, stop,
/// Hub shutdown) used to leave its broker accept loops, registry maintenance
/// and report retries running: the replacement runtime found
/// `auth-broker.sock` still served by the old one, fell back to a TCP port the
/// daemon record never advertised, and two reconcilers fought over one
/// registry file.
#[derive(Clone, Default)]
pub struct ProfileTaskSet {
    handles: std::sync::Arc<std::sync::Mutex<Vec<tokio::task::AbortHandle>>>,
}

impl ProfileTaskSet {
    pub fn new() -> Self {
        Self::default()
    }

    fn track(&self, handle: tokio::task::AbortHandle) {
        if let Ok(mut handles) = self.handles.lock() {
            handles.retain(|tracked| !tracked.is_finished());
            handles.push(handle);
        }
    }

    /// Tasks that are still running.
    pub fn live(&self) -> usize {
        self.handles
            .lock()
            .map(|handles| {
                handles
                    .iter()
                    .filter(|handle| !handle.is_finished())
                    .count()
            })
            .unwrap_or(0)
    }

    /// Cancel every tracked task and wait, briefly, for the runtime to drop
    /// them: a dropped socket listener unlinks its path, which is what the
    /// replacement runtime needs to find gone.
    pub async fn abort_all(&self) -> usize {
        let handles = self
            .handles
            .lock()
            .map(|mut handles| std::mem::take(&mut *handles))
            .unwrap_or_default();
        for handle in &handles {
            handle.abort();
        }
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
        while handles.iter().any(|handle| !handle.is_finished())
            && tokio::time::Instant::now() < deadline
        {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        handles.len()
    }
}

pub async fn scope_profile_tasks<F: std::future::Future>(
    tasks: ProfileTaskSet,
    future: F,
) -> F::Output {
    TASK_PROFILE_TASKS.scope(tasks, future).await
}

/// Installs the immutable profile selected at process admission.
///
/// A one-shot CLI invocation admits exactly one process profile. DaemonHost
/// actors instead install their immutable context in task-local scope.
pub fn install_process_profile_context(context: ProfileContext) -> Result<()> {
    if PROCESS_AGENT_CLI_HUB.get().is_some() {
        return Err(CliError::Auth(
            "Agent command routing is already installed".into(),
        ));
    }
    if let Some(current) = PROCESS_PROFILE_CONTEXT.get() {
        if current == &context {
            return Ok(());
        }
        return Err(CliError::Auth(
            "The process profile context was already fixed at admission".into(),
        ));
    }
    PROCESS_PROFILE_CONTEXT
        .set(context)
        .map_err(|_| CliError::Auth("Failed to fix the process profile context".into()))
}

pub fn process_profile_context() -> Option<&'static ProfileContext> {
    PROCESS_PROFILE_CONTEXT.get()
}

/// Returns the immutable Profile context owned by the current actor or CLI.
/// A daemon actor's task-local context takes precedence over the one-shot CLI
/// process context so sibling actors never share a mutable selector.
pub fn active_profile_context() -> Option<ProfileContext> {
    TASK_PROFILE_CONTEXT
        .try_with(Clone::clone)
        .ok()
        .or_else(|| process_profile_context().cloned())
}

pub async fn scope_profile_context<F: std::future::Future>(
    context: ProfileContext,
    future: F,
) -> F::Output {
    TASK_PROFILE_CONTEXT.scope(context, future).await
}

pub fn spawn_profile_task<F>(future: F) -> tokio::task::JoinHandle<F::Output>
where
    F: std::future::Future + Send + 'static,
    F::Output: Send + 'static,
{
    let tasks = TASK_PROFILE_TASKS.try_with(Clone::clone).ok();
    let handle = match (active_profile_context(), tasks.clone()) {
        (Some(context), Some(tasks)) => tokio::spawn(
            TASK_PROFILE_CONTEXT.scope(context, TASK_PROFILE_TASKS.scope(tasks, future)),
        ),
        (Some(context), None) => tokio::spawn(TASK_PROFILE_CONTEXT.scope(context, future)),
        (None, Some(tasks)) => tokio::spawn(TASK_PROFILE_TASKS.scope(tasks, future)),
        (None, None) => tokio::spawn(future),
    };
    if let Some(tasks) = tasks {
        tasks.track(handle.abort_handle());
    }
    handle
}

/// The configured location for local Run logs and registry sidecars.
pub fn daemon_run_log_dir() -> PathBuf {
    std::env::var("XMATRIX_RUN_LOG_DIR")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| profile_state_dir().join("runs"))
}

/// Enumerate sidecar filenames; each consumer still validates its own records.
/// Best-effort callers treat an unreadable directory as an empty iterator.
pub fn daemon_run_sidecar_paths(dir: &Path) -> impl Iterator<Item = PathBuf> {
    std::fs::read_dir(dir)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(std::result::Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(".registry.json"))
        })
}

/// Profile-scoped state root for the admitted CLI invocation or daemon actor.
/// Installation-scoped callers must continue using `config_dir()`.
pub fn profile_state_dir() -> PathBuf {
    active_profile_context()
        .map(|context| context.state_root.as_path().to_path_buf())
        .unwrap_or_else(config_dir)
}

pub fn config_path() -> PathBuf {
    profile_state_dir().join("config.json")
}

pub fn session_path() -> PathBuf {
    profile_state_dir().join("session.json")
}

pub fn sessions_dir() -> PathBuf {
    profile_state_dir().join("sessions")
}

pub fn normalized_hub_origin(hub_url: &str) -> String {
    let normalized = normalize_hub_url(Some(hub_url));
    reqwest::Url::parse(&normalized)
        .ok()
        .map(|url| url.origin().ascii_serialization())
        .unwrap_or(normalized)
}

pub fn session_path_for_hub(hub_url: &str) -> PathBuf {
    let hub = normalized_hub_origin(hub_url);
    let file_name = if hub == DEFAULT_HUB_URL {
        "production.json".to_string()
    } else if hub == TEST_HUB_URL {
        "test.json".to_string()
    } else {
        format!("custom-{}.json", sha256_hex(hub.as_bytes()))
    };
    sessions_dir().join(file_name)
}

/// Atomically promotes a same-directory temporary file over its destination.
///
/// The temporary file must be on the same filesystem as the destination.
/// Rust maps this to the platform's replace-existing rename operation; callers
/// must not delete the durable destination first and create a crash window.
pub fn replace_file_atomically(temporary: &Path, destination: &Path) -> std::io::Result<()> {
    std::fs::rename(temporary, destination)
}

/// Returns a collision-resistant temporary path beside `destination`.
pub fn unique_temporary_path(destination: &Path) -> PathBuf {
    let mut file_name = destination.file_name().unwrap_or_default().to_os_string();
    file_name.push(format!(
        ".tmp-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    destination.with_file_name(file_name)
}

/// Root of Claude Code's per-project transcript store (`<claude config>/projects`).
/// Honors `CLAUDE_CONFIG_DIR`, else falls back to `~/.claude`. Claude resolves
/// `--resume <id>` against the transcript directory for the *current* working
/// directory, so this is how we verify a resume session belongs to a given cwd.
pub fn claude_projects_dir() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("CLAUDE_CONFIG_DIR") {
        let trimmed = dir.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed).join("projects"));
        }
    }
    dirs::home_dir().map(|home| home.join(".claude").join("projects"))
}

pub async fn load_config() -> CliConfig {
    let path = config_path();
    match tokio::fs::read_to_string(&path).await {
        Ok(raw) => parse_config(&raw).unwrap_or_else(|err| {
            eprintln!(
                "Warning: failed to parse xMatrix config at {}: {err}",
                path.display()
            );
            CliConfig::default()
        }),
        Err(_) => CliConfig::default(),
    }
}

pub async fn active_environment() -> String {
    if let Some(context) = active_profile_context() {
        return context.name;
    }
    load_config()
        .await
        .active_environment
        .filter(|value| matches!(value.as_str(), "production" | "test"))
        .unwrap_or_else(|| "production".to_string())
}

pub async fn active_hub_url() -> String {
    if let Some(hub) = agent_cli_hub() {
        return hub.to_string();
    }
    if let Some(context) = active_profile_context() {
        return context.hub_origin;
    }
    match active_environment().await.as_str() {
        "test" => TEST_HUB_URL.to_string(),
        _ => DEFAULT_HUB_URL.to_string(),
    }
}

pub async fn saved_cloudflared_path() -> Option<PathBuf> {
    load_config().await.cloudflared_path.map(PathBuf::from)
}

pub async fn save_cloudflared_path(path: &Path) -> Result<()> {
    let mut config = load_config().await;
    config.cloudflared_path = Some(path.to_string_lossy().to_string());
    write_config(&config).await
}

pub async fn load_session() -> Option<CliSession> {
    let hub_url = active_hub_url().await;
    load_session_for_hub(&hub_url).await
}

pub async fn load_session_for_hub(hub_url: &str) -> Option<CliSession> {
    let hub = normalized_hub_origin(hub_url);
    let path = session_path_for_hub(&hub);
    if let Ok(raw) = tokio::fs::read_to_string(&path).await {
        match parse_session(&raw) {
            Ok(session) if normalized_hub_origin(&session.hub_url) == hub => {
                return Some(session);
            }
            Ok(_) => {
                eprintln!(
                    "Warning: refusing xMatrix session at {} because its Hub origin does not match {}",
                    path.display(),
                    hub
                );
            }
            Err(err) => {
                eprintln!(
                    "Warning: failed to parse xMatrix session at {}: {err}",
                    path.display()
                );
            }
        }
    }

    let legacy = load_legacy_session().await?;
    let legacy_hub = normalized_hub_origin(&legacy.hub_url);
    let legacy_path = session_path_for_hub(&legacy_hub);
    if !legacy_path.exists()
        && let Err(err) = write_session(&legacy).await
    {
        eprintln!("Warning: failed to migrate legacy xMatrix session: {err}");
        return (legacy_hub == hub).then_some(legacy);
    }
    if let Err(err) = remove_legacy_session().await {
        eprintln!("Warning: failed to remove migrated legacy xMatrix session: {err}");
    }
    (legacy_hub == hub).then_some(legacy)
}

pub async fn save_session(
    token: String,
    refresh_token: Option<String>,
    user: AuthUser,
    hub_url: String,
    relay_url: String,
    expires_at: Option<String>,
) -> Result<CliSession> {
    migrate_legacy_session().await?;
    let hub = normalized_hub_origin(&hub_url);
    let relay = if relay_url.is_empty() {
        derive_human_connection_url(&hub)
    } else {
        relay_url
    };

    let session = CliSession {
        token,
        refresh_token,
        user,
        hub_url: hub,
        relay_url: relay,
        updated_at: chrono_now(),
        expires_at: expires_at.unwrap_or_else(default_session_expires_at),
    };

    let dir = profile_state_dir();
    tokio::fs::create_dir_all(&dir).await?;

    write_session(&session).await?;

    let mut config = load_config().await;
    if config.session.is_some() {
        config.session = None;
        write_config(&config).await?;
    }

    Ok(session)
}

pub async fn clear_session_for_hub(hub_url: &str) -> Result<()> {
    let mut config = load_config().await;
    config.session = None;
    let session_remove = tokio::fs::remove_file(session_path_for_hub(hub_url)).await;
    if let Err(e) = session_remove
        && e.kind() != std::io::ErrorKind::NotFound
    {
        return Err(CliError::Io(e));
    }
    write_config(&config).await
}

pub async fn clear_all_sessions() -> Result<()> {
    clear_all_sessions_in_state_root(&profile_state_dir()).await
}

pub async fn clear_all_sessions_in_state_root(state_root: &Path) -> Result<()> {
    let config_path = state_root.join("config.json");
    let sanitized_config = match tokio::fs::read_to_string(&config_path).await {
        Ok(raw) => {
            let mut value: serde_json::Value =
                serde_json::from_str(raw.trim_start_matches('\u{feff}'))?;
            let Some(object) = value.as_object_mut() else {
                return Err(CliError::Auth(format!(
                    "Invalid xMatrix config at {}",
                    config_path.display()
                )));
            };
            object
                .remove("session")
                .map(|_| serde_json::to_vec_pretty(&value))
                .transpose()?
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
        Err(err) => return Err(CliError::Io(err)),
    };
    ignore_missing(tokio::fs::remove_dir_all(state_root.join("sessions")).await)?;
    ignore_missing(tokio::fs::remove_file(state_root.join("session.json")).await)?;
    if let Some(json) = sanitized_config {
        write_private_json_atomically(&config_path, &json).await?;
    }
    Ok(())
}

/// The Machine id of this host for the owner logged in to `hub_url`.
pub async fn get_or_create_machine_id(hub_url: &str) -> Result<String> {
    Ok(get_or_create_machine_identity(hub_url).await?.machine_id)
}

/// The Machine identity of this host for the owner logged in to `hub_url`.
pub async fn get_or_create_machine_identity(hub_url: &str) -> Result<MachineIdentity> {
    let session = match load_session_for_hub(hub_url).await {
        Some(session) => session,
        None => load_session().await.ok_or_else(|| {
            CliError::Auth("A Machine is identified per owner. Run: xmatrix login".into())
        })?,
    };
    machine_identity_for_owner(&session.user.id).await
}

/// A Machine is its host: the id is derived from the owner and the host
/// fingerprint, so every install, profile and config directory of this host
/// names the same Machine, and a host name change keeps it. Nothing is minted
/// except a last-resort seed where the host exposes no identity at all.
pub async fn machine_identity_for_owner(owner_user_id: &str) -> Result<MachineIdentity> {
    let mut config = load_config().await;
    let fingerprint = match current_machine_fingerprint() {
        Some(fingerprint) => fingerprint,
        None => {
            let seed = match config.machine_seed.clone() {
                Some(seed) if !seed.trim().is_empty() => seed,
                _ => {
                    let seed = format!(
                        "{}{}",
                        uuid::Uuid::new_v4().simple(),
                        uuid::Uuid::new_v4().simple()
                    );
                    config.machine_seed = Some(seed.clone());
                    write_config(&config).await?;
                    seed
                }
            };
            MachineFingerprint {
                source: "config-seed".to_string(),
                value: stable_fingerprint_value("config-seed", &seed),
            }
        }
    };
    let machine_id = derive_machine_id(owner_user_id, &fingerprint.value);
    let parent_machine_id = wsl_host_fingerprint().map(|host| {
        derive_machine_id(
            owner_user_id,
            &stable_fingerprint_value("windows-machineguid", &host),
        )
    });
    Ok(MachineIdentity {
        legacy_machine_ids: legacy_machine_ids(&config, &machine_id),
        machine_id,
        fingerprint,
        parent_machine_id,
    })
}

/// `machine:` + SHA-256 of the owner and the host fingerprint.
pub fn derive_machine_id(owner_user_id: &str, host_fingerprint: &str) -> String {
    let digest =
        sha256_hex(format!("xmatrix-machine-v1\0{owner_user_id}\0{host_fingerprint}").as_bytes());
    format!("{MACHINE_ID_PREFIX}{digest}")
}

fn is_derived_machine_id(value: &str) -> bool {
    value.strip_prefix(MACHINE_ID_PREFIX).is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    })
}

/// Ids an earlier CLI minted in this config directory; the Hub adopts their
/// records into the derived id once, and they are then forgotten.
fn legacy_machine_ids(config: &CliConfig, machine_id: &str) -> Vec<String> {
    let mut ids = Vec::new();
    let previous = config
        .previous_machine_ids
        .iter()
        .map(|entry| entry.machine_id.as_str());
    for id in valid_machine_id(config.machine_id.as_deref())
        .into_iter()
        .chain(previous)
    {
        let id = id.trim();
        if id != machine_id && !is_derived_machine_id(id) && !ids.iter().any(|known| known == id) {
            ids.push(id.to_string());
        }
    }
    ids
}

/// Legacy ids still waiting for the Hub to adopt them into `machine_id`.
pub async fn pending_legacy_machine_ids(machine_id: &str) -> Vec<String> {
    legacy_machine_ids(&load_config().await, machine_id)
}

/// Forgets legacy ids after the Hub reported them adopted.
pub async fn forget_legacy_machine_ids(adopted: &[String]) -> Result<()> {
    if adopted.is_empty() {
        return Ok(());
    }
    let mut config = load_config().await;
    let is_adopted = |id: &str| adopted.iter().any(|value| value == id.trim());
    if config.machine_id.as_deref().is_some_and(is_adopted) {
        config.machine_id = None;
        config.machine_fingerprint = None;
    }
    config
        .previous_machine_ids
        .retain(|entry| !is_adopted(&entry.machine_id));
    write_config(&config).await
}

async fn write_config(config: &CliConfig) -> Result<()> {
    let json = serde_json::to_string_pretty(config)?;
    write_private_json_atomically(&config_path(), json.as_bytes()).await
}

async fn write_session(session: &CliSession) -> Result<()> {
    let json = serde_json::to_string_pretty(session)?;
    write_private_json_atomically(&session_path_for_hub(&session.hub_url), json.as_bytes()).await
}

async fn load_legacy_session() -> Option<CliSession> {
    if let Ok(raw) = tokio::fs::read_to_string(session_path()).await {
        match parse_session(&raw) {
            Ok(session) => return Some(session),
            Err(err) => {
                eprintln!(
                    "Warning: failed to parse legacy xMatrix session at {}: {err}",
                    session_path().display()
                );
            }
        }
    }
    load_config().await.session
}

async fn migrate_legacy_session() -> Result<()> {
    let Some(legacy) = load_legacy_session().await else {
        return Ok(());
    };
    let destination = session_path_for_hub(&legacy.hub_url);
    if !destination.exists() {
        write_session(&legacy).await?;
    }
    remove_legacy_session().await
}

fn ignore_missing(result: std::io::Result<()>) -> Result<()> {
    crate::fs::missing_file_as_none(result)?;
    Ok(())
}

async fn remove_legacy_session() -> Result<()> {
    ignore_missing(tokio::fs::remove_file(session_path()).await)?;
    let mut config = load_config().await;
    if config.session.take().is_some() {
        write_config(&config).await?;
    }
    Ok(())
}

async fn write_private_json_atomically(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| CliError::Auth("Invalid xMatrix config file path".into()))?;
    tokio::fs::create_dir_all(parent).await?;
    let temporary = unique_temporary_path(path);

    if let Err(err) = tokio::fs::write(&temporary, bytes).await {
        return Err(CliError::Io(err));
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o600);
        if let Err(err) = std::fs::set_permissions(&temporary, perms) {
            let _ = tokio::fs::remove_file(&temporary).await;
            return Err(CliError::Io(err));
        }
    }

    if let Err(err) = replace_file_atomically(&temporary, path) {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(CliError::Io(err));
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }

    Ok(())
}

fn valid_machine_id(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| {
        value.starts_with(MACHINE_ID_PREFIX) && value.len() > MACHINE_ID_PREFIX.len()
    })
}

fn current_machine_fingerprint() -> Option<MachineFingerprint> {
    platform_machine_fingerprint().map(|(source, value)| MachineFingerprint {
        source: source.to_string(),
        value: stable_fingerprint_value(source, &value),
    })
}

#[cfg(target_os = "macos")]
fn platform_machine_fingerprint() -> Option<(&'static str, String)> {
    let output = std::process::Command::new("ioreg")
        .args(["-rd1", "-c", "IOPlatformExpertDevice"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let uuid = stdout.lines().find_map(|line| {
        let (_, value) = line.split_once("\"IOPlatformUUID\" = ")?;
        Some(value.trim().trim_matches('"').to_string())
    })?;
    (!uuid.is_empty()).then_some(("darwin-ioplatformuuid", uuid))
}

#[cfg(target_os = "windows")]
fn platform_machine_fingerprint() -> Option<(&'static str, String)> {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut command = std::process::Command::new("reg");
    command.creation_flags(CREATE_NO_WINDOW);
    let guid = query_machine_guid(command)?;
    Some(("windows-machineguid", guid))
}

/// `reg query` prints the key path before the value line, so the GUID is the
/// last field of the `MachineGuid` line, not of the first line.
#[cfg(any(test, target_os = "windows", all(unix, not(target_os = "macos"))))]
fn parse_machine_guid(output: &str) -> Option<String> {
    output
        .lines()
        .find_map(|line| {
            let mut fields = line.split_whitespace();
            (fields.next() == Some("MachineGuid")).then(|| fields.last().map(str::to_string))?
        })
        .filter(|guid| !guid.is_empty())
}

#[cfg(any(target_os = "windows", all(unix, not(target_os = "macos"))))]
fn query_machine_guid(mut command: std::process::Command) -> Option<String> {
    let output = command
        .args([
            "query",
            r"HKLM\SOFTWARE\Microsoft\Cryptography",
            "/v",
            "MachineGuid",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_machine_guid(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn platform_machine_fingerprint() -> Option<(&'static str, String)> {
    // A WSL distribution is its own Machine on its Windows host. Its own
    // machine-id is often empty without systemd and is copied verbatim by
    // `wsl --export/--import`, so the host GUID plus the distribution name
    // identifies it; without interop the distribution's machine-id is used.
    if let (Some(distro), Some(host)) = (wsl_distro_name(), wsl_host_fingerprint()) {
        return Some(("wsl-distro", format!("{host}\0{distro}")));
    }
    ["/etc/machine-id", "/var/lib/dbus/machine-id"]
        .iter()
        .find_map(|path| {
            let value = std::fs::read_to_string(path).ok()?;
            let trimmed = value.trim().to_string();
            (!trimmed.is_empty()).then_some(("linux-machine-id", trimmed))
        })
}

#[cfg(all(unix, not(target_os = "macos")))]
fn wsl_distro_name() -> Option<String> {
    let release = std::fs::read_to_string("/proc/sys/kernel/osrelease").ok()?;
    if !release.to_ascii_lowercase().contains("microsoft") {
        return None;
    }
    // A service started without WSL's environment still resolves its
    // distribution through `wslpath`, so both paths name the same Machine.
    std::env::var("WSL_DISTRO_NAME")
        .ok()
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .or_else(|| {
            let output = std::process::Command::new("wslpath")
                .args(["-w", "/"])
                .output()
                .ok()?;
            output
                .status
                .success()
                .then(|| wsl_distro_from_unc(&String::from_utf8_lossy(&output.stdout)))?
        })
}

/// `\\wsl.localhost\Ubuntu\` or `\\wsl$\Ubuntu\` → `Ubuntu`.
#[cfg(any(test, all(unix, not(target_os = "macos"))))]
fn wsl_distro_from_unc(path: &str) -> Option<String> {
    let name = path
        .trim()
        .trim_start_matches('\\')
        .split('\\')
        .nth(1)?
        .trim();
    (!name.is_empty()).then(|| name.to_string())
}

/// The Windows host's MachineGuid, read through WSL interop.
#[cfg(all(unix, not(target_os = "macos")))]
fn wsl_host_fingerprint() -> Option<String> {
    wsl_distro_name()?;
    ["reg.exe", "/mnt/c/Windows/System32/reg.exe"]
        .iter()
        .find_map(|program| query_machine_guid(std::process::Command::new(program)))
}

#[cfg(not(all(unix, not(target_os = "macos"))))]
fn wsl_host_fingerprint() -> Option<String> {
    None
}

#[cfg(not(any(unix, target_os = "windows")))]
fn platform_machine_fingerprint() -> Option<(&'static str, String)> {
    None
}

fn stable_fingerprint_value(source: &str, raw_value: &str) -> String {
    let input = format!("{source}\0{}", raw_value.trim());
    format!("{source}:{}", sha256_hex(input.as_bytes()))
}

fn chrono_now() -> String {
    use std::time::SystemTime;
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    // Simple ISO-ish timestamp without chrono dependency
    format!("{now}")
}

pub fn unix_now_secs() -> u64 {
    use std::time::SystemTime;
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub fn renewed_session_expires_at() -> String {
    unix_now_secs()
        .saturating_add(SESSION_MAX_AGE_SECS)
        .to_string()
}

fn default_session_expires_at() -> String {
    renewed_session_expires_at()
}

fn parse_config(raw: &str) -> serde_json::Result<CliConfig> {
    serde_json::from_str(raw.trim_start_matches('\u{feff}'))
}

fn parse_session(raw: &str) -> serde_json::Result<CliSession> {
    serde_json::from_str(raw.trim_start_matches('\u{feff}'))
}

#[cfg(test)]
#[path = "../tests/support/process_env.rs"]
mod process_env;
#[cfg(test)]
pub(crate) use process_env::test_process_env_lock as test_env_lock;

#[cfg(test)]
#[expect(
    clippy::await_holding_lock,
    reason = "each #[tokio::test] runs on its own thread; the guard only serializes process-global env across test threads"
)]
mod tests {
    use super::{
        CliConfig, ProfileTaskSet, SESSION_MAX_AGE_SECS, config_path, derive_machine_id,
        forget_legacy_machine_ids, is_derived_machine_id, legacy_machine_ids, load_config,
        load_session_for_hub, parse_config, parse_machine_guid, pending_legacy_machine_ids,
        profile_state_dir, renewed_session_expires_at, replace_file_atomically, save_session,
        scope_profile_context, scope_profile_tasks, session_path_for_hub, spawn_profile_task,
        stable_fingerprint_value, test_env_lock, unique_temporary_path, unix_now_secs,
        valid_machine_id, wsl_distro_from_unc,
    };
    use crate::profile::{InstallationRoot, ProfileStore};
    use crate::protocol::AuthUser;

    #[tokio::test]
    async fn concurrent_actor_scopes_keep_distinct_profile_roots() {
        let root = std::env::temp_dir().join(format!(
            "xmatrix-config-profile-scopes-{}",
            uuid::Uuid::new_v4()
        ));
        let (store, created) = isolated_profile_store(&root);
        let legacy = store.context_for_default(&created).unwrap();
        let isolated = store
            .context_for_selector(&created, "isolated", false)
            .unwrap();
        let expected_legacy = legacy.state_root.as_path().to_path_buf();
        let expected_isolated = isolated.state_root.as_path().to_path_buf();

        let (observed_legacy, observed_isolated) = tokio::join!(
            scope_profile_context(legacy, async {
                tokio::task::yield_now().await;
                profile_state_dir()
            }),
            scope_profile_context(isolated, async {
                tokio::task::yield_now().await;
                profile_state_dir()
            })
        );
        assert_eq!(observed_legacy, expected_legacy);
        assert_eq!(observed_isolated, expected_isolated);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn nested_profile_tasks_retain_the_actor_context() {
        let root = std::env::temp_dir().join(format!(
            "xmatrix-config-profile-nested-task-{}",
            uuid::Uuid::new_v4()
        ));
        let (store, created) = isolated_profile_store(&root);
        let isolated = store
            .context_for_selector(&created, "isolated", false)
            .unwrap();
        let expected = isolated.state_root.as_path().to_path_buf();

        let observed = scope_profile_context(isolated, async {
            spawn_profile_task(async { profile_state_dir() })
                .await
                .unwrap()
        })
        .await;

        assert_eq!(observed, expected);
        let _ = std::fs::remove_dir_all(root);
    }

    fn isolated_profile_store(
        root: &std::path::Path,
    ) -> (ProfileStore, crate::profile::ProfileRegistry) {
        let store = ProfileStore::new(InstallationRoot::new(root.to_path_buf()));
        let initial = store.load_or_bootstrap().unwrap();
        let created = store
            .create(initial.revision, "isolated", "https://example.com", true)
            .unwrap();
        (store, created)
    }

    fn temp_config_dir(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("xmatrix-{name}-{}", uuid::Uuid::new_v4()))
    }

    fn set_test_config_dir(dir: &std::path::Path) {
        // Tests hold `test_env_lock` while mutating process-wide environment.
        unsafe {
            std::env::set_var("XMATRIX_CONFIG_DIR", dir);
        }
    }

    fn clear_test_config_dir() {
        // Tests hold `test_env_lock` while mutating process-wide environment.
        unsafe {
            std::env::remove_var("XMATRIX_CONFIG_DIR");
        }
    }

    #[test]
    fn parse_config_accepts_utf8_bom() {
        let config = parse_config(
            "\u{feff}{\"machineId\":\"machine:test\",\"machineFingerprint\":{\"source\":\"test\",\"value\":\"test:1\"}}",
        )
        .unwrap();

        assert_eq!(config.machine_id.as_deref(), Some("machine:test"));
        assert_eq!(
            config
                .machine_fingerprint
                .as_ref()
                .map(|value| value.source.as_str()),
            Some("test")
        );
    }

    #[test]
    fn valid_machine_id_requires_prefixed_non_empty_value() {
        assert_eq!(valid_machine_id(Some(" machine:abc ")), Some("machine:abc"));
        assert_eq!(valid_machine_id(Some("machine:")), None);
        assert_eq!(valid_machine_id(Some("host:abc")), None);
        assert_eq!(valid_machine_id(None), None);
    }

    #[test]
    fn renewed_session_expiry_is_seven_days_from_now() {
        let before = unix_now_secs().saturating_add(SESSION_MAX_AGE_SECS);
        let expires_at = renewed_session_expires_at().parse::<u64>().unwrap();
        let after = unix_now_secs().saturating_add(SESSION_MAX_AGE_SECS);

        assert!(expires_at >= before);
        assert!(expires_at <= after);
    }

    #[test]
    fn atomic_file_replace_overwrites_an_existing_destination() {
        let dir = temp_config_dir("atomic-replace");
        std::fs::create_dir_all(&dir).unwrap();
        let destination = dir.join("state.json");
        let temporary = dir.join("state.json.tmp");
        std::fs::write(&destination, "old").unwrap();
        std::fs::write(&temporary, "new").unwrap();

        replace_file_atomically(&temporary, &destination).unwrap();

        assert_eq!(std::fs::read_to_string(&destination).unwrap(), "new");
        assert!(!temporary.exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn unique_temporary_files_stay_beside_the_destination() {
        let destination = std::path::PathBuf::from("root").join("state.json");
        let first = unique_temporary_path(&destination);
        let second = unique_temporary_path(&destination);

        assert_eq!(first.parent(), destination.parent());
        assert_eq!(second.parent(), destination.parent());
        assert_ne!(first, second);
        assert!(
            first
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("state.json.tmp-")
        );
    }

    #[test]
    fn machine_id_is_derived_from_owner_and_host_only() {
        let first = derive_machine_id("owner", "darwin-ioplatformuuid:abc");
        assert!(is_derived_machine_id(&first));
        assert_eq!(
            first,
            derive_machine_id("owner", "darwin-ioplatformuuid:abc")
        );
        assert_ne!(
            first,
            derive_machine_id("other", "darwin-ioplatformuuid:abc")
        );
        assert_ne!(
            first,
            derive_machine_id("owner", "darwin-ioplatformuuid:abd")
        );
        assert!(!is_derived_machine_id(
            "machine:11111111-1111-4111-8111-111111111111"
        ));
    }

    #[test]
    fn machine_guid_is_read_from_its_value_line_not_the_key_path() {
        let output = "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    8c4a2f1e-0000-4000-8000-000000000001\r\n\r\n";
        assert_eq!(
            parse_machine_guid(output).as_deref(),
            Some("8c4a2f1e-0000-4000-8000-000000000001")
        );
        assert_eq!(
            parse_machine_guid("HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n"),
            None
        );
    }

    #[test]
    fn wsl_distribution_name_comes_from_its_unc_root() {
        assert_eq!(
            wsl_distro_from_unc("\\\\wsl.localhost\\Ubuntu-22.04\\\n").as_deref(),
            Some("Ubuntu-22.04")
        );
        assert_eq!(
            wsl_distro_from_unc("\\\\wsl$\\Debian\\").as_deref(),
            Some("Debian")
        );
        assert_eq!(wsl_distro_from_unc("/"), None);
    }

    #[test]
    fn legacy_ids_are_minted_ids_other_than_the_current_one() {
        let derived = derive_machine_id("owner", "test:1");
        let config: CliConfig = parse_config(&format!(
            r#"{{"machineId":"machine:old","previousMachineIds":[
              {{"machineId":"machine:older","rotatedAt":"1","reason":"test"}},
              {{"machineId":"machine:old","rotatedAt":"1","reason":"test"}},
              {{"machineId":"{derived}","rotatedAt":"1","reason":"test"}}]}}"#
        ))
        .unwrap();
        assert_eq!(
            legacy_machine_ids(&config, &derived),
            vec!["machine:old", "machine:older"]
        );
    }

    #[tokio::test]
    async fn adopted_legacy_ids_are_forgotten_and_others_kept() {
        let _guard = test_env_lock();
        let dir = temp_config_dir("forget-legacy");
        set_test_config_dir(&dir);
        tokio::fs::create_dir_all(&dir).await.unwrap();
        tokio::fs::write(
            config_path(),
            r#"{"machineId":"machine:old","machineFingerprint":{"source":"test","value":"test:1"},
              "previousMachineIds":[{"machineId":"machine:older","rotatedAt":"1","reason":"test"}]}"#,
        )
        .await
        .unwrap();

        forget_legacy_machine_ids(&["machine:old".to_string()])
            .await
            .unwrap();
        let config = load_config().await;
        assert_eq!(config.machine_id, None);
        assert_eq!(config.machine_fingerprint, None);
        assert_eq!(
            pending_legacy_machine_ids("machine:x").await,
            vec!["machine:older"]
        );

        clear_test_config_dir();
        let _ = tokio::fs::remove_dir_all(dir).await;
    }

    #[test]
    fn stable_fingerprint_value_hides_raw_platform_identifier() {
        let value = stable_fingerprint_value("darwin-ioplatformuuid", "ABC-123");
        assert!(value.starts_with("darwin-ioplatformuuid:"));
        assert!(!value.contains("ABC-123"));
        assert_eq!(
            value,
            stable_fingerprint_value("darwin-ioplatformuuid", "ABC-123")
        );
    }

    #[tokio::test]
    async fn load_session_falls_back_to_legacy_config_session() {
        let _guard = test_env_lock();
        let dir = temp_config_dir("legacy-session");
        set_test_config_dir(&dir);
        tokio::fs::create_dir_all(&dir).await.unwrap();
        tokio::fs::write(
            config_path(),
            r#"{
              "machineId": "machine:test",
              "machineFingerprint": { "source": "test", "value": "test:1" },
              "session": {
                "token": "legacy-access",
                "refreshToken": "legacy-refresh",
                "user": { "id": "user:test", "email": "test@example.com" },
                "hubUrl": "https://xmatrix.test",
                "relayUrl": "wss://xmatrix.test/ws",
                "updatedAt": "1",
                "expiresAt": "2"
              }
            }"#,
        )
        .await
        .unwrap();

        let session = load_session_for_hub("https://xmatrix.test").await.unwrap();

        assert_eq!(session.token, "legacy-access");
        assert_eq!(session.refresh_token.as_deref(), Some("legacy-refresh"));

        clear_test_config_dir();
        let _ = tokio::fs::remove_dir_all(dir).await;
    }

    #[tokio::test]
    async fn save_session_writes_split_session_and_clears_legacy_config_session() {
        let _guard = test_env_lock();
        let dir = temp_config_dir("split-session");
        set_test_config_dir(&dir);
        tokio::fs::create_dir_all(&dir).await.unwrap();
        tokio::fs::write(
            config_path(),
            r#"{
              "machineId": "machine:test",
              "machineFingerprint": { "source": "test", "value": "test:1" },
              "previousMachineIds": [
                {
                  "machineId": "machine:old",
                  "machineFingerprint": { "source": "test", "value": "test:0" },
                  "rotatedAt": "1",
                  "reason": "test"
                }
              ],
              "session": {
                "token": "legacy-access",
                "user": { "id": "user:test", "email": "test@example.com" },
                "hubUrl": "https://xmatrix.test",
                "relayUrl": "wss://xmatrix.test/ws",
                "updatedAt": "1",
                "expiresAt": "2"
              }
            }"#,
        )
        .await
        .unwrap();

        let saved = save_session(
            "split-access".to_string(),
            Some("split-refresh".to_string()),
            AuthUser {
                id: "user:test".to_string(),
                email: "test@example.com".to_string(),
                name: None,
            },
            "https://xmatrix.test".to_string(),
            "wss://xmatrix.test/ws".to_string(),
            Some("3".to_string()),
        )
        .await
        .unwrap();
        let config = load_config().await;
        let raw_config = tokio::fs::read_to_string(config_path()).await.unwrap();
        let raw_session = tokio::fs::read_to_string(session_path_for_hub("https://xmatrix.test"))
            .await
            .unwrap();

        assert_eq!(saved.token, "split-access");
        assert_eq!(config.machine_id.as_deref(), Some("machine:test"));
        assert_eq!(
            config
                .machine_fingerprint
                .as_ref()
                .map(|value| value.value.as_str()),
            Some("test:1")
        );
        assert_eq!(config.previous_machine_ids.len(), 1);
        assert!(config.session.is_none());
        assert!(!raw_config.contains("split-access"));
        assert!(!raw_config.contains("legacy-access"));
        assert!(raw_session.contains("split-access"));
        assert_eq!(
            load_session_for_hub("https://xmatrix.test")
                .await
                .unwrap()
                .token,
            "split-access"
        );

        clear_test_config_dir();
        let _ = tokio::fs::remove_dir_all(dir).await;
    }

    #[tokio::test]
    async fn sessions_are_selected_only_by_exact_hub_origin() {
        let _guard = test_env_lock();
        let dir = temp_config_dir("origin-sessions");
        set_test_config_dir(&dir);
        let user = AuthUser {
            id: "user:test".to_string(),
            email: "test@example.com".to_string(),
            name: None,
        };
        save_session(
            "production-token".to_string(),
            None,
            user.clone(),
            "https://xmatrix-hub.xmatrix.sh".to_string(),
            "wss://xmatrix-hub.xmatrix.sh/ws".to_string(),
            None,
        )
        .await
        .unwrap();
        save_session(
            "test-token".to_string(),
            None,
            user,
            "https://xmatrix-hub.test.xmatrix.sh".to_string(),
            "wss://xmatrix-hub.test.xmatrix.sh/ws".to_string(),
            None,
        )
        .await
        .unwrap();

        assert_eq!(
            load_session_for_hub("https://xmatrix-hub.xmatrix.sh")
                .await
                .unwrap()
                .token,
            "production-token"
        );
        assert_eq!(
            load_session_for_hub("https://xmatrix-hub.test.xmatrix.sh")
                .await
                .unwrap()
                .token,
            "test-token"
        );
        assert_eq!(
            load_session_for_hub("https://xmatrix-hub.test.xmatrix.sh/api/ignored")
                .await
                .unwrap()
                .token,
            "test-token"
        );
        assert!(
            load_session_for_hub("https://xmatrix-hub.test.xmatrix.sh:8443")
                .await
                .is_none()
        );
        assert!(
            load_session_for_hub("https://other.example")
                .await
                .is_none()
        );

        clear_test_config_dir();
        let _ = tokio::fs::remove_dir_all(dir).await;
    }

    #[tokio::test]
    async fn a_profile_actor_takes_its_spawned_tasks_down_with_it() {
        let tasks = ProfileTaskSet::new();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let scoped = tasks.clone();
        scope_profile_tasks(scoped, async move {
            // A broker accept loop and the task it hands each connection to:
            // the grandchild must be tracked through the inherited scope.
            spawn_profile_task(async move {
                spawn_profile_task(std::future::pending::<()>());
                let _ = started_tx.send(());
                std::future::pending::<()>().await;
            });
        })
        .await;
        started_rx.await.expect("the tracked task ran");
        assert_eq!(tasks.live(), 2);

        let cancelled = tasks.abort_all().await;

        assert_eq!(cancelled, 2);
        assert_eq!(tasks.live(), 0);
    }

    #[tokio::test]
    async fn an_untracked_profile_task_still_spawns() {
        let handle = spawn_profile_task(async { 7 });
        assert_eq!(handle.await.unwrap(), 7);
    }
}
