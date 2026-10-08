#![deny(warnings)]

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use colored::Colorize;
use serde::Deserialize;
use xmatrix_cli_args::WorkspaceCommand;
use xmatrix_cli_core::error::{self, CliError};
use xmatrix_cli_core::protocol::{HubRoutes, with_route};
use xmatrix_cli_core::{config, http, protocol};

#[derive(Deserialize)]
struct WorkspaceResponse {
    workspace: protocol::SerializedWorkspace,
}

#[derive(Deserialize)]
struct WorkspacesResponse {
    workspaces: Vec<protocol::SerializedWorkspace>,
}

pub fn observed_hostname() -> String {
    gethostname::gethostname().to_string_lossy().to_string()
}

fn path_display_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| path.to_string_lossy().to_string())
}

fn normalize_workspace_path_for_storage(path: &Path) -> String {
    let value = path.to_string_lossy().to_string();
    normalize_workspace_path_string_for_storage(&value)
}

fn canonical_or_absolute(path: &Path) -> error::Result<PathBuf> {
    if let Ok(canonical) = path.canonicalize() {
        return Ok(canonical);
    }
    if path.is_absolute() {
        return Ok(path.to_path_buf());
    }
    Ok(std::env::current_dir()?.join(path))
}

fn paths_overlap(left: &Path, right: &Path) -> bool {
    #[cfg(windows)]
    {
        let left = normalize_workspace_path_for_storage(left)
            .trim_end_matches(['\\', '/'])
            .to_ascii_lowercase();
        let right = normalize_workspace_path_for_storage(right)
            .trim_end_matches(['\\', '/'])
            .to_ascii_lowercase();
        let under = |candidate: &str, root: &str| {
            candidate == root
                || candidate
                    .strip_prefix(root)
                    .is_some_and(|rest| rest.starts_with(['\\', '/']))
        };
        under(&left, &right) || under(&right, &left)
    }
    #[cfg(not(windows))]
    {
        left.starts_with(right) || right.starts_with(left)
    }
}

fn app_owned_storage_roots() -> Vec<PathBuf> {
    let mut roots = vec![config::config_dir()];
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join(".xmatrix-management"));
        roots.push(home.join(".xmatrix-management-quarantine"));
    }
    roots
}

pub fn workspace_path_overlaps_app_owned_storage(path: &Path) -> error::Result<bool> {
    let workspace = canonical_or_absolute(path)?;
    for root in app_owned_storage_roots() {
        let root = canonical_or_absolute(&root)?;
        if paths_overlap(&workspace, &root) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn validate_workspace_path_isolated(path: &Path) -> error::Result<()> {
    if workspace_path_overlaps_app_owned_storage(path)? {
        return Err(CliError::Launch(format!(
            "Workspace '{}' overlaps xMatrix-owned configuration or management storage; register a project directory instead of a home or xMatrix data directory",
            path.display()
        )));
    }
    Ok(())
}

pub fn normalize_workspace_path_string_for_storage(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    if let Some(rest) = path.strip_prefix(r"\\?\") {
        return rest.to_string();
    }
    path.to_string()
}

/// A quiet background Git metadata probe, with fsmonitor disabled.
pub fn git_probe_command(cwd: &Path, args: &[&str]) -> std::process::Command {
    let mut command = std::process::Command::new("git");
    configure_background_command(&mut command);
    command
        .args(["-c", "core.fsmonitor=false"])
        .arg("-C")
        .arg(cwd)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

/// Wait for a probe; its owner retains the exact child/tree cleanup policy.
pub fn wait_for_git_probe(
    child: &mut std::process::Child,
    timeout: Duration,
    on_abort: impl FnOnce(&mut std::process::Child, bool),
) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            status => {
                on_abort(child, status.is_ok());
                return false;
            }
        }
    }
}

fn git_output(cwd: &Path, args: &[&str]) -> Option<String> {
    const GIT_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
    let mut child = git_probe_command(cwd, args).spawn().ok()?;
    if !wait_for_git_probe(&mut child, GIT_PROBE_TIMEOUT, |child, _| {
        let _ = child.kill();
        let _ = child.wait();
    }) {
        return None;
    }
    let output = child.wait_with_output().ok()?;

    if !output.status.success() {
        return None;
    }

    let value = String::from_utf8(output.stdout).ok()?.trim().to_string();
    if value.is_empty() { None } else { Some(value) }
}

#[cfg(windows)]
fn configure_background_command(command: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn configure_background_command(_command: &mut std::process::Command) {}

fn workspace_payload(
    path: &Path,
    display_name: Option<&str>,
    machine_id: &str,
    runtime: Option<&str>,
) -> error::Result<serde_json::Value> {
    let canonical = path.canonicalize().map_err(|err| {
        CliError::Launch(format!(
            "Failed to resolve workspace path '{}': {err}",
            path.display()
        ))
    })?;
    validate_workspace_path_isolated(&canonical)?;
    let hostname = observed_hostname();
    let repo_root = git_output(&canonical, &["rev-parse", "--show-toplevel"]);
    let git_branch = git_output(&canonical, &["branch", "--show-current"]);
    let git_remote = git_output(&canonical, &["remote", "get-url", "origin"]);
    let name = display_name
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| path_display_name(&canonical));
    let canonical_cwd = normalize_workspace_path_for_storage(&canonical);

    Ok(serde_json::json!({
        "machineId": machine_id,
        "hostname": hostname,
        "canonicalCwd": canonical_cwd,
        "displayName": name,
        "repoRoot": repo_root,
        "gitRemote": git_remote,
        "gitBranch": git_branch,
        "runtime": runtime,
    }))
}

pub async fn upsert_workspace(
    hub_url: &str,
    token: &str,
    path: &Path,
    display_name: Option<&str>,
    runtime: Option<&str>,
) -> error::Result<protocol::SerializedWorkspace> {
    let machine_id = config::get_or_create_machine_id(hub_url).await?;
    let payload = workspace_payload(path, display_name, &machine_id, runtime)?;
    let response: WorkspaceResponse = http::request_json(
        &with_route(hub_url, HubRoutes::WORKSPACES),
        "POST",
        Some(token),
        Some(payload),
    )
    .await?;
    Ok(response.workspace)
}

/// The caller's Workspace at `path` on this machine, registering it first when
/// it is not registered yet. An existing registration is returned unchanged.
pub async fn ensure_workspace(
    hub_url: &str,
    token: &str,
    path: &Path,
) -> error::Result<protocol::SerializedWorkspace> {
    let canonical = path.canonicalize().map_err(|err| {
        CliError::Launch(format!(
            "Failed to resolve workspace path '{}': {err}",
            path.display()
        ))
    })?;
    let machine_id = config::get_or_create_machine_id(hub_url).await?;
    let cwd = normalize_workspace_path_for_storage(&canonical);
    if let Some(workspace) = list_workspaces(hub_url, token)
        .await?
        .into_iter()
        .find(|workspace| workspace.machine_id == machine_id && workspace.canonical_cwd == cwd)
    {
        return Ok(workspace);
    }
    upsert_workspace(hub_url, token, &canonical, None, None).await
}

pub async fn list_workspaces(
    hub_url: &str,
    token: &str,
) -> error::Result<Vec<protocol::SerializedWorkspace>> {
    let response: WorkspacesResponse = http::request_json(
        &with_route(hub_url, HubRoutes::WORKSPACES),
        "GET",
        Some(token),
        None,
    )
    .await?;
    Ok(response.workspaces)
}

/// Lists only workspaces authorized to the exact Machine Daemon principal.
/// Human workspace APIs deliberately remain a separate call path.
///
/// Spawn fail-closes if this list cannot be read. A single packet-level
/// transport failure therefore used to abort `@agent:new` while the same
/// failure moments later was only logged. Retry the idempotent GET on
/// transport errors; Hub 4xx/5xx stay fail-closed on the first response.
pub async fn list_machine_daemon_workspaces(
    hub_url: &str,
    machine_credential: &str,
) -> error::Result<Vec<protocol::SerializedWorkspace>> {
    let url = with_route(hub_url, HubRoutes::MACHINE_DAEMON_WORKSPACES);
    let mut attempt = 0;
    loop {
        match http::request_json::<WorkspacesResponse>(&url, "GET", Some(machine_credential), None)
            .await
        {
            Ok(response) => return Ok(response.workspaces),
            Err(error) if is_retryable_workspace_list_error(&error) => {
                if let Some(delay) = workspace_list_retry_delay(attempt) {
                    eprintln!(
                        "{} machine daemon workspace listing failed ({error}); retrying",
                        "⚠".yellow().bold()
                    );
                    tokio::time::sleep(delay).await;
                    attempt += 1;
                    continue;
                }
                return Err(error);
            }
            Err(error) => return Err(error),
        }
    }
}

const WORKSPACE_LIST_RETRY_BACKOFF_MS: [u64; 2] = [250, 750];

fn workspace_list_retry_delay(attempt: u32) -> Option<Duration> {
    usize::try_from(attempt)
        .ok()
        .and_then(|index| WORKSPACE_LIST_RETRY_BACKOFF_MS.get(index))
        .map(|millis| Duration::from_millis(*millis))
}

fn is_retryable_workspace_list_error(error: &CliError) -> bool {
    matches!(error, CliError::Request(_)) || error.is_transient()
}

fn canonical_path_key(path: &str) -> error::Result<String> {
    let canonical = Path::new(path).canonicalize().map_err(|err| {
        CliError::Launch(format!(
            "Failed to resolve workspace path '{}': {err}",
            path
        ))
    })?;
    let key = normalize_workspace_path_for_storage(&canonical);
    #[cfg(windows)]
    {
        Ok(key.to_ascii_lowercase())
    }
    #[cfg(not(windows))]
    {
        Ok(key)
    }
}

pub async fn validate_daemon_workspace_allowed(
    hub_url: &str,
    token: &str,
    machine_id: &str,
    host_id: &str,
    workspace: &protocol::DaemonSpawnWorkspace,
) -> error::Result<()> {
    validate_workspace_path_isolated(Path::new(&workspace.canonical_cwd))?;
    if workspace.machine_id != machine_id {
        return Err(CliError::Launch(format!(
            "Workspace '{}' is registered for machine '{}', but this daemon is machine '{}'",
            workspace.display_name, workspace.machine_id, machine_id
        )));
    }

    let requested_path = canonical_path_key(&workspace.canonical_cwd)?;
    let allowed = list_machine_daemon_workspaces(hub_url, token).await?;
    let is_allowed = allowed.iter().any(|candidate| {
        let candidate_matches_machine = candidate.machine_id == machine_id;
        if !candidate_matches_machine {
            return false;
        }
        canonical_path_key(&candidate.canonical_cwd)
            .map(|candidate_path| candidate_path == requested_path)
            .unwrap_or(false)
    });

    if !is_allowed {
        return Err(CliError::Launch(format!(
            "Workspace '{}' ({}) is not registered as an allowed working directory for daemon host '{}'",
            workspace.display_name, workspace.canonical_cwd, host_id
        )));
    }

    Ok(())
}

/// Re-check the machine-local path boundary after the Hub has already
/// authorized the exact registered workspace in the combined admission call.
pub fn validate_daemon_workspace_path_isolated(
    workspace: &protocol::DaemonSpawnWorkspace,
) -> error::Result<()> {
    validate_workspace_path_isolated(Path::new(&workspace.canonical_cwd))
}

fn resolve_workspace_ref<'a>(
    workspaces: &'a [protocol::SerializedWorkspace],
    workspace_ref: &str,
) -> error::Result<&'a protocol::SerializedWorkspace> {
    let matches = workspaces
        .iter()
        .filter(|workspace| {
            workspace.canonical_cwd == workspace_ref || workspace.display_name == workspace_ref
        })
        .collect::<Vec<_>>();
    match matches.as_slice() {
        [workspace] => Ok(*workspace),
        [] => Err(CliError::Launch(format!(
            "Workspace '{workspace_ref}' not found; pass its absolute path or an unambiguous display name"
        ))),
        _ => Err(CliError::Launch(format!(
            "Workspace name '{workspace_ref}' is ambiguous; pass its absolute path"
        ))),
    }
}

pub async fn cmd_workspace(
    hub_url: &str,
    token: &str,
    command: WorkspaceCommand,
) -> error::Result<()> {
    match command {
        WorkspaceCommand::Register { path, name } => {
            let path = path.unwrap_or(std::env::current_dir()?);
            let workspace = upsert_workspace(hub_url, token, &path, name.as_deref(), None).await?;
            println!(
                "{} Registered workspace {}",
                "✓".green().bold(),
                workspace.display_name
            );
            println!("  machine: {}", workspace.machine_id);
            println!(
                "  hostname: {}",
                workspace.hostname.as_deref().unwrap_or("unknown")
            );
            println!("  cwd: {}", workspace.canonical_cwd);
        }
        WorkspaceCommand::List => {
            let workspaces = list_workspaces(hub_url, token).await?;
            if workspaces.is_empty() {
                println!("No workspaces registered. Run xmatrix from a project directory.");
                return Ok(());
            }
            println!(
                "{:<22} {:<18} {:<10} {:<18} {}",
                "NAME".bold(),
                "MACHINE".bold(),
                "VISIBILITY".bold(),
                "RUNTIMES".bold(),
                "PATH".bold()
            );
            for workspace in &workspaces {
                let runtimes = if workspace.runtimes_seen.is_empty() {
                    "-".to_string()
                } else {
                    workspace.runtimes_seen.join(",")
                };
                println!(
                    "{:<22} {:<18} {:<10} {:<18} {}",
                    workspace.display_name,
                    workspace.machine_id,
                    workspace.visibility,
                    runtimes,
                    workspace.canonical_cwd.dimmed()
                );
            }
        }
        WorkspaceCommand::Unregister { workspace } => {
            let workspaces = list_workspaces(hub_url, token).await?;
            let resolved = resolve_workspace_ref(&workspaces, &workspace)?;
            http::request_json::<serde_json::Value>(
                &with_route(hub_url, HubRoutes::WORKSPACES),
                "DELETE",
                Some(token),
                Some(serde_json::json!({
                    "machineId": resolved.machine_id,
                    "canonicalCwd": resolved.canonical_cwd,
                })),
            )
            .await?;
            println!(
                "{} Unregistered workspace {}",
                "✓".green().bold(),
                resolved.display_name
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        CliError, is_retryable_workspace_list_error, normalize_workspace_path_string_for_storage,
        paths_overlap, workspace_list_retry_delay,
    };
    use std::path::Path;
    use std::time::Duration;

    #[test]
    fn workspace_path_storage_strips_windows_verbatim_prefix() {
        assert_eq!(
            normalize_workspace_path_string_for_storage(r"\\?\C:\Users\dev\Projects\NomadCafe"),
            r"C:\Users\dev\Projects\NomadCafe"
        );
        assert_eq!(
            normalize_workspace_path_string_for_storage(r"\\?\UNC\server\share\repo"),
            r"\\server\share\repo"
        );
    }

    #[test]
    fn workspace_overlap_rejects_ancestors_descendants_and_exact_roots() {
        let owned = Path::new("/home/dev/.config/xmatrix");
        assert!(paths_overlap(Path::new("/home/dev"), owned));
        assert!(paths_overlap(
            Path::new("/home/dev/.config/xmatrix/relay-v2"),
            owned
        ));
        assert!(paths_overlap(owned, owned));
        assert!(!paths_overlap(
            Path::new("/home/dev/Projects/xmatrix"),
            owned
        ));
    }

    #[test]
    fn workspace_listing_retries_a_bounded_number_of_transport_failures() {
        assert_eq!(
            workspace_list_retry_delay(0),
            Some(Duration::from_millis(250))
        );
        assert_eq!(
            workspace_list_retry_delay(1),
            Some(Duration::from_millis(750))
        );
        assert_eq!(workspace_list_retry_delay(2), None);
        assert!(!is_retryable_workspace_list_error(&CliError::Http(
            "not registered".into()
        )));
        assert!(!is_retryable_workspace_list_error(&CliError::Launch(
            "workspace missing".into()
        )));
        assert!(is_retryable_workspace_list_error(
            &CliError::RelayTransient("error sending request for url".into())
        ));
    }
}
