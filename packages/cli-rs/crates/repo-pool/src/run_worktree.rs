//! Per-run execution worktrees.
//!
//! When the daemon summons a headless agent it can materialize a dedicated
//! git worktree for that run instead of running the agent inside the base
//! workspace checkout. The worktree is owned by the run (not the channel,
//! not the workspace record): it is a disposable execution slot cut from the
//! base repository's freshest default-branch commit, while branches/commits
//! remain the durable artifacts the agent pushes from inside it.
//!
//! Invariants:
//! - A run worktree is never registered as a workspace. The daemon passes the
//!   base machine + canonical path so the child process can attribute the run
//!   to the real workspace without upserting its execution cwd.
//! - Materialization failure is never fatal: callers fall back to spawning in
//!   the base workspace checkout.
//! - Durable resume runs only reuse their existing worktree (agent session
//!   stores are keyed by cwd, so a resumed run must land in the cwd it
//!   previously ran in). A Hub-marked legacy migration may create one new
//!   isolated tree; it never repairs or removes an existing Git record.

use colored::Colorize;
use serde::{Deserialize, Serialize};
use sha2::Digest as _;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::io::AsyncReadExt;
use xmatrix_cli_core::hex::lowercase_hex;

use super::repo_pool;
use xmatrix_process_tree as process_tree;

/// Override for per-run worktrees. Unset = marker-driven (a spawn
/// materializes when the Hub marked it as a repo summon). Explicitly falsy =
/// kill-switch (never materialize). Explicitly truthy = force for all
/// headless spawns (testing/legacy dark-launch behavior).
pub const RUN_WORKTREES_ENABLED_ENV: &str = "XMATRIX_RUN_WORKTREES";
/// Override for the root directory that holds materialized run worktrees.
pub const RUN_WORKTREES_DIR_ENV: &str = "XMATRIX_RUN_WORKTREES_DIR";
/// Natural workspace identity handed to a daemon-spawned agent so the child
/// can skip auto-register/upsert of its execution cwd.
pub const SPAWN_WORKSPACE_MACHINE_ID_ENV: &str = "XMATRIX_WORKSPACE_MACHINE_ID";
pub const SPAWN_WORKSPACE_CWD_ENV: &str = "XMATRIX_WORKSPACE_CWD";
/// Display name for the Hub workspace bound to this spawn. Set for direct
/// in-place daemon launches so child connect metadata can keep workspaceName
/// without re-upserting the registry row.
pub const SPAWN_WORKSPACE_NAME_ENV: &str = "XMATRIX_WORKSPACE_NAME";
/// The ref the run worktree was cut from, for run-metadata observability.
pub const RUN_WORKTREE_BASE_REF_ENV: &str = "XMATRIX_RUN_WORKTREE_BASE_REF";
/// GC apply switch. Unset = apply. Explicit 0/false/no/off is dry-run.
pub const RUN_WORKTREES_GC_APPLY_ENV: &str = "XMATRIX_RUN_WORKTREES_GC";
/// Override for how many ended-run worktrees the LRU pool keeps.
pub const RUN_WORKTREES_KEEP_ENV: &str = "XMATRIX_RUN_WORKTREES_KEEP";
/// Override for how long a non-`run-*` linked worktree may sit idle.
pub const RUN_WORKTREES_NAMED_TTL_SECS_ENV: &str = "XMATRIX_RUN_WORKTREES_NAMED_TTL_SECS";
/// Soft watermark: run aggressive reclaim before creating new execution trees.
pub const WORKTREE_DISK_WARN_BYTES_ENV: &str = "XMATRIX_WORKTREE_DISK_WARN_BYTES";
/// Hard watermark: refuse new worktree/slot creation below this free space.
pub const WORKTREE_DISK_MIN_BYTES_ENV: &str = "XMATRIX_WORKTREE_DISK_MIN_BYTES";

const DEFAULT_LRU_KEEP: usize = 12;
const DEFAULT_NAMED_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const PRESSURE_NAMED_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const DEFAULT_DISK_WARN_BYTES: u64 = 20 * 1024 * 1024 * 1024;
const DEFAULT_DISK_MIN_BYTES: u64 = 5 * 1024 * 1024 * 1024;

#[cfg(test)]
thread_local! {
    static TEST_DISK_MIN_BYTES: std::cell::Cell<Option<u64>> = const { std::cell::Cell::new(None) };
}
/// Lock reason prefix marking locks the daemon itself placed. GC may unlock
/// these for non-live trees; locks with any other reason are always honored.
const LOCK_REASON_PREFIX: &str = "xmatrix-run:";
const BINDINGS_FILE_NAME: &str = ".xmatrix-run-worktree-bindings.json";

pub(crate) const GIT_LOCAL_TIMEOUT: Duration = Duration::from_secs(20);
/// Legacy hard wall-clock used by quiet/non-progress git helpers that must
/// still bound network ops (for example `remote set-head --auto`).
const GIT_FETCH_TIMEOUT: Duration = Duration::from_secs(30);
/// No stderr/stdout progress for this long => treat the fetch as stuck.
const GIT_FETCH_STALL_TIMEOUT: Duration = Duration::from_secs(30);
/// Absolute ceiling for a progress-streaming fetch even while bytes keep
/// flowing. Mirrors the clone budget so large repos can finish.
const GIT_FETCH_MAX_TIMEOUT: Duration = Duration::from_secs(180);
const GIT_CLONE_TIMEOUT: Duration = Duration::from_secs(180);
/// Staging a whole checkout and pushing it for a cross-machine handoff.
const GIT_HANDOFF_TIMEOUT: Duration = Duration::from_secs(120);
const GH_CLONE_TIMEOUT: Duration = Duration::from_secs(180);
const GIT_WORKTREE_ADD_TIMEOUT: Duration = Duration::from_secs(120);
const GIT_GC_MUTATION_TIMEOUT: Duration = Duration::from_secs(120);
/// Rate-limit progress lines so a busy fetch does not flood daemon logs.
const GIT_PROGRESS_LOG_INTERVAL: Duration = Duration::from_secs(2);

pub struct MaterializedRunWorktree {
    pub path: PathBuf,
    pub base_ref: String,
    pub reused: bool,
}

/// Env values a spawn carries when its cwd is a materialized run worktree.
pub struct RunWorktreeSpawnEnv {
    pub base_machine_id: String,
    pub base_canonical_cwd: String,
    pub base_ref: String,
}

pub struct DaemonProvidedWorkspace {
    pub machine_id: String,
    pub canonical_cwd: String,
}

/// A local durable record that the daemon successfully materialized a specific
/// resume session's worktree. It lives beside the worktrees so a power loss
/// cannot turn a later reborn into permission to invent a replacement tree.
#[derive(Default, Deserialize, Serialize)]
struct RunWorktreeBindings {
    version: u8,
    bindings: BTreeMap<String, RunWorktreeBinding>,
}

#[derive(Deserialize, Serialize)]
struct RunWorktreeBinding {
    path: String,
    base_workspace: String,
}

#[derive(Clone, Copy)]
enum BaseRefFreshness {
    BestEffort,
    RequireRemoteFetch,
}

pub fn run_worktree_spawn_enabled(marker: bool) -> bool {
    spawn_enabled_from(
        marker,
        std::env::var(RUN_WORKTREES_ENABLED_ENV).ok().as_deref(),
    )
}

fn spawn_enabled_from(marker: bool, env: Option<&str>) -> bool {
    if flag_value_disabled(env) {
        return false;
    }
    if flag_value_enabled(env) {
        return true;
    }
    marker
}

/// GC sweeps opportunistically whenever run worktrees may exist on disk and
/// the kill-switch is not set.
pub fn gc_sweep_enabled() -> bool {
    !flag_value_disabled(std::env::var(RUN_WORKTREES_ENABLED_ENV).ok().as_deref())
        && run_worktrees_root().is_dir()
}

fn flag_value_enabled(value: Option<&str>) -> bool {
    matches!(
        value.map(str::trim).map(str::to_ascii_lowercase).as_deref(),
        Some("1") | Some("true") | Some("yes") | Some("on")
    )
}

fn flag_value_disabled(value: Option<&str>) -> bool {
    matches!(
        value.map(str::trim).map(str::to_ascii_lowercase).as_deref(),
        Some("0") | Some("false") | Some("no") | Some("off")
    )
}

pub fn run_worktrees_root() -> PathBuf {
    if let Ok(dir) = std::env::var(RUN_WORKTREES_DIR_ENV) {
        let trimmed = dir.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".xmatrix")
        .join("worktrees")
}

fn bindings_path(root: &Path) -> PathBuf {
    root.join(BINDINGS_FILE_NAME)
}

fn load_bindings(root: &Path) -> Result<RunWorktreeBindings, String> {
    let path = bindings_path(root);
    match std::fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).map_err(|error| {
            format!(
                "cannot read durable run-worktree bindings at {}: {error}",
                path.display()
            )
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(RunWorktreeBindings {
            version: 1,
            ..RunWorktreeBindings::default()
        }),
        Err(error) => Err(format!(
            "cannot read durable run-worktree bindings at {}: {error}",
            path.display()
        )),
    }
}

fn save_bindings(root: &Path, bindings: &RunWorktreeBindings) -> Result<(), String> {
    std::fs::create_dir_all(root).map_err(|error| {
        format!(
            "cannot create run-worktree root {}: {error}",
            root.display()
        )
    })?;
    let path = bindings_path(root);
    let bytes = serde_json::to_vec_pretty(bindings)
        .map_err(|error| format!("cannot serialize durable run-worktree bindings: {error}"))?;
    let temporary = xmatrix_cli_core::config::unique_temporary_path(&path);
    if let Err(error) = std::fs::write(&temporary, bytes)
        .and_then(|()| xmatrix_cli_core::config::replace_file_atomically(&temporary, &path))
    {
        let _ = std::fs::remove_file(&temporary);
        return Err(format!(
            "cannot persist durable run-worktree bindings at {}: {error}",
            path.display()
        ));
    }
    Ok(())
}

fn record_binding(root: &Path, key: &str, base_cwd: &Path, path: &Path) -> Result<(), String> {
    let binding_key =
        run_worktree_dir_name(key).ok_or_else(|| format!("unusable worktree key {key:?}"))?;
    let mut bindings = load_bindings(root)?;
    bindings.version = 1;
    bindings.bindings.insert(
        binding_key,
        RunWorktreeBinding {
            path: path.display().to_string(),
            base_workspace: base_cwd.display().to_string(),
        },
    );
    save_bindings(root, &bindings)
}

fn resume_reuse_only_at(
    root: &Path,
    key: &str,
    resume: bool,
    legacy_bootstrap_allowed: bool,
) -> Result<bool, String> {
    if !resume || !legacy_bootstrap_allowed {
        return Ok(resume);
    }
    let binding_key =
        run_worktree_dir_name(key).ok_or_else(|| format!("unusable worktree key {key:?}"))?;
    Ok(load_bindings(root)?.bindings.contains_key(&binding_key))
}

/// A reborn with an explicit legacy-migration grant can create one isolated
/// worktree only when this machine has no durable record of a prior successful
/// materialization. Once recorded, a missing tree remains an actionable error.
pub fn resume_reuse_only(
    key: &str,
    resume: bool,
    legacy_bootstrap_allowed: bool,
) -> Result<bool, String> {
    resume_reuse_only_at(&run_worktrees_root(), key, resume, legacy_bootstrap_allowed)
}

/// Deterministic directory name for a worktree key. The key is the spawn's
/// resume session key when present (stable across reborn/resume, so a resumed
/// session lands back in the same tree — the Codex thread identity), falling
/// back to the run id for keyless spawns (e.g. Automations). Hashed
/// because keys are concatenations of ids whose shared prefixes would collide
/// if truncated. Returns `None` for an empty key (spawn falls back to the
/// base workspace).
fn run_worktree_dir_name(key: &str) -> Option<String> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return None;
    }
    let digest = sha2::Sha256::digest(trimmed.as_bytes());
    Some(format!("run-{}", lowercase_hex(&digest[..6])))
}

/// A linked git worktree (its `.git` is a file pointing at the parent repo,
/// not a directory) is an execution site, never a project root: our own run
/// worktrees, Codex App thread checkouts, and ad-hoc `git worktree add`
/// directories all share this shape, while real project checkouts have a
/// `.git` directory. Used to keep execution sites out of the workspace
/// registry regardless of which tool created them.
pub fn is_linked_git_worktree(path: &Path) -> bool {
    path.join(".git").is_file()
}

/// Natural workspace authority provided by the daemon for this spawn.
pub fn daemon_provided_workspace() -> Option<DaemonProvidedWorkspace> {
    let machine_id = std::env::var(SPAWN_WORKSPACE_MACHINE_ID_ENV).ok()?;
    let canonical_cwd = std::env::var(SPAWN_WORKSPACE_CWD_ENV).ok()?;
    let machine_id = machine_id.trim();
    let canonical_cwd = canonical_cwd.trim();
    if machine_id.is_empty() || canonical_cwd.is_empty() {
        return None;
    }
    Some(DaemonProvidedWorkspace {
        machine_id: machine_id.to_string(),
        canonical_cwd: canonical_cwd.to_string(),
    })
}

/// Create (or reuse) the detached worktree for `key`, cut from the base
/// repository's freshest default-branch commit. Errors are advisory: callers
/// log them and spawn in the base workspace instead.
pub async fn materialize_run_worktree(
    base_cwd: &Path,
    key: &str,
    reuse_only: bool,
) -> Result<MaterializedRunWorktree, String> {
    materialize_run_worktree_at(&run_worktrees_root(), base_cwd, key, reuse_only).await
}

/// Create (or reuse) a run worktree for a remote repo reference, preferring an
/// existing local checkout from the supplied machine-local candidates before
/// falling back to the daemon-managed clone cache.
pub async fn materialize_run_worktree_for_remote_with_candidates(
    selected_base_cwd: &Path,
    candidate_base_cwds: &[PathBuf],
    remote_repo: &str,
    key: &str,
    reuse_only: bool,
) -> Result<MaterializedRunWorktree, String> {
    materialize_run_worktree_for_remote_at(
        &run_worktrees_root(),
        selected_base_cwd,
        candidate_base_cwds,
        remote_repo,
        key,
        reuse_only,
    )
    .await
}

async fn materialize_run_worktree_for_remote_at(
    root: &Path,
    selected_base_cwd: &Path,
    candidate_base_cwds: &[PathBuf],
    remote_repo: &str,
    key: &str,
    reuse_only: bool,
) -> Result<MaterializedRunWorktree, String> {
    let base_cwd = prepare_remote_repo_base_with_candidates(
        selected_base_cwd,
        candidate_base_cwds,
        remote_repo,
    )
    .await?;
    materialize_run_worktree_at_with_freshness(
        root,
        &base_cwd,
        key,
        reuse_only,
        BaseRefFreshness::RequireRemoteFetch,
    )
    .await
}

/// Repo-key pool parent is the daemon-managed clone only. A registered
/// workspace checkout of the same remote must never become the pool base:
/// that mixes git common-dirs inside one repo-identity pool.
pub async fn prepare_repo_pool_base(remote_repo: &str) -> Result<PathBuf, String> {
    ensure_remote_repo_accessible(remote_repo).await?;
    ensure_managed_repo_checkout(remote_repo).await
}

/// Resolve an authenticated base checkout for a remote repo without creating
/// a run worktree. The legacy `run-*` materializer may still reuse a local
/// candidate checkout; the repo-key pool must not.
pub(crate) async fn prepare_remote_repo_base_with_candidates(
    selected_base_cwd: &Path,
    candidate_base_cwds: &[PathBuf],
    remote_repo: &str,
) -> Result<PathBuf, String> {
    ensure_remote_repo_accessible(remote_repo).await?;
    let candidate_cwds = remote_repo_checkout_candidates(selected_base_cwd, candidate_base_cwds);
    Ok(
        match find_existing_repo_checkout(&candidate_cwds, remote_repo).await {
            Some(path) => path,
            None => ensure_managed_repo_checkout(remote_repo).await?,
        },
    )
}

async fn ensure_remote_repo_accessible(remote_repo: &str) -> Result<(), String> {
    let repo_ref = clean_remote_repo_ref(remote_repo)
        .ok_or_else(|| format!("invalid remote repository reference {remote_repo:?}"))?;
    let mut errors = Vec::new();

    if repo_ref_looks_like_owner_repo(&repo_ref) {
        match gh(
            &["repo", "view", &repo_ref, "--json", "nameWithOwner"],
            GIT_LOCAL_TIMEOUT,
        )
        .await
        {
            Ok(_) => return Ok(()),
            Err(err) => errors.push(err),
        }

        let https_url = format!("https://github.com/{repo_ref}.git");
        match git_no_cwd(
            &["ls-remote", "--exit-code", &https_url, "HEAD"],
            GIT_LOCAL_TIMEOUT,
        )
        .await
        {
            Ok(_) => return Ok(()),
            Err(err) => errors.push(err),
        }

        let ssh_url = format!("git@github.com:{repo_ref}.git");
        match git_no_cwd(
            &["ls-remote", "--exit-code", &ssh_url, "HEAD"],
            GIT_LOCAL_TIMEOUT,
        )
        .await
        {
            Ok(_) => return Ok(()),
            Err(err) => errors.push(err),
        }
    } else {
        let remote_url = clone_url_for_repo_ref(&repo_ref);
        match git_no_cwd(
            &["ls-remote", "--exit-code", &remote_url, "HEAD"],
            GIT_LOCAL_TIMEOUT,
        )
        .await
        {
            Ok(_) => return Ok(()),
            Err(err) => errors.push(err),
        }
    }

    Err(format!(
        "remote repository {repo_ref} is not accessible: {}",
        errors
            .last()
            .cloned()
            .unwrap_or_else(|| "no access checks were run".to_string())
    ))
}

fn remote_repo_checkout_candidates(
    selected_base_cwd: &Path,
    candidate_base_cwds: &[PathBuf],
) -> Vec<PathBuf> {
    let mut paths = Vec::with_capacity(candidate_base_cwds.len() + 1);
    push_unique_path(&mut paths, selected_base_cwd.to_path_buf());
    for path in candidate_base_cwds {
        push_unique_path(&mut paths, path.clone());
    }
    paths
}

fn push_unique_path(paths: &mut Vec<PathBuf>, path: PathBuf) {
    let key = path_key(&path);
    if paths.iter().any(|existing| path_key(existing) == key) {
        return;
    }
    paths.push(path);
}

fn path_key(path: &Path) -> String {
    let value = path.to_string_lossy().replace('\\', "/");
    #[cfg(windows)]
    {
        value.to_ascii_lowercase()
    }
    #[cfg(not(windows))]
    {
        value
    }
}

async fn find_existing_repo_checkout(
    candidate_base_cwds: &[PathBuf],
    remote_repo: &str,
) -> Option<PathBuf> {
    for path in candidate_base_cwds {
        if !path.exists() || is_linked_git_worktree(path) {
            continue;
        }
        if repository_matches_remote(path, remote_repo).await {
            return Some(path.clone());
        }
    }
    None
}

async fn ensure_managed_repo_checkout(remote_repo: &str) -> Result<PathBuf, String> {
    let repo_ref = clean_remote_repo_ref(remote_repo)
        .ok_or_else(|| format!("invalid remote repository reference {remote_repo:?}"))?;
    let path = managed_repo_path(&repo_ref);
    // The active daemon's per-path coordinator serializes first materialization
    // of this shared clone cache without creating filesystem lock authority.
    let _managed_checkout_guard = acquire_managed_repo_checkout_guard(&path).await?;
    if path.join(".git").exists() {
        // Callers resolve/fetch the exact base snapshot after selection. Avoid
        // a second network mutation in discovery, especially under contention.
        return Ok(path);
    }
    if path.exists() {
        return Err(format!(
            "managed repository path {} already exists and is not a git checkout",
            path.display()
        ));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("failed to create {}: {err}", parent.display()))?;
    }
    let path_arg = path.display().to_string();
    /* `gh` authenticates as the machine's own GitHub login, which is wider than
    any one Space. A launch that carries a Space grant clones through Git so
    the credential helper hands it that Space's repository token and nothing
    else — a repository the Space was not granted then fails here instead of
    succeeding on the human's personal access. */
    let gh_result =
        if !repo_pool::space_scoped_git_capability() && repo_ref_looks_like_owner_repo(&repo_ref) {
            gh(
                &["repo", "clone", &repo_ref, &path_arg, "--", "--no-checkout"],
                GH_CLONE_TIMEOUT,
            )
            .await
        } else {
            Err("clone routed through Git credentials".to_string())
        };
    if gh_result.is_err() {
        let clone_url = clone_url_for_repo_ref(&repo_ref);
        git_no_cwd(
            &["clone", "--no-checkout", &clone_url, &path_arg],
            GIT_CLONE_TIMEOUT,
        )
        .await?;
    }
    Ok(path)
}

#[derive(Debug)]
struct ManagedRepoCheckoutGuard {
    _process_guard: tokio::sync::OwnedMutexGuard<()>,
}

fn managed_repo_checkout_coordinator(
    managed_repo: &Path,
) -> std::sync::Arc<tokio::sync::Mutex<()>> {
    static COORDINATORS: std::sync::OnceLock<repo_pool::PathCoordinators> =
        std::sync::OnceLock::new();
    repo_pool::path_coordinator(COORDINATORS.get_or_init(Default::default), managed_repo)
}

async fn acquire_managed_repo_checkout_guard(
    managed_repo: &Path,
) -> Result<ManagedRepoCheckoutGuard, String> {
    if !managed_repo.is_absolute() {
        return Err("managed repository path must be absolute".to_string());
    }
    Ok(ManagedRepoCheckoutGuard {
        _process_guard: managed_repo_checkout_coordinator(managed_repo)
            .lock_owned()
            .await,
    })
}

fn managed_repo_path(remote_repo: &str) -> PathBuf {
    let safe: String = remote_repo
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
                ch
            } else {
                '-'
            }
        })
        .collect();
    run_worktrees_root()
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".xmatrix")
        })
        .join("repos")
        .join(safe.trim_matches('-'))
}

async fn repository_matches_remote(base_cwd: &Path, remote_repo: &str) -> bool {
    let Ok(inside) = git(
        base_cwd,
        &["rev-parse", "--is-inside-work-tree"],
        GIT_LOCAL_TIMEOUT,
    )
    .await
    else {
        return false;
    };
    if inside != "true" {
        return false;
    }
    let Ok(origin) = git(
        base_cwd,
        &["remote", "get-url", "origin"],
        GIT_LOCAL_TIMEOUT,
    )
    .await
    else {
        return false;
    };
    git_reference_matches(remote_repo, &origin)
}

fn clean_remote_repo_ref(remote_repo: &str) -> Option<String> {
    let trimmed = remote_repo
        .trim()
        .trim_end_matches('/')
        .trim_end_matches('\\');
    if trimmed.is_empty() || trimmed.contains(char::is_whitespace) {
        return None;
    }
    Some(trimmed.trim_end_matches(".git").to_string())
}

fn repo_ref_looks_like_owner_repo(repo_ref: &str) -> bool {
    let parts: Vec<_> = repo_ref.split('/').collect();
    parts.len() == 2 && parts.iter().all(|part| !part.is_empty())
}

fn clone_url_for_repo_ref(repo_ref: &str) -> String {
    if repo_ref.contains("://") || repo_ref.starts_with("git@") || repo_ref.starts_with("ssh://") {
        repo_ref.to_string()
    } else if repo_ref_looks_like_owner_repo(repo_ref) {
        format!("https://github.com/{repo_ref}.git")
    } else {
        repo_ref.to_string()
    }
}

fn git_reference_matches(reference: &str, value: &str) -> bool {
    let reference = normalize_git_reference(reference);
    let value = normalize_git_reference(value);
    if reference.is_empty() || value.is_empty() {
        return false;
    }
    value == reference || value.ends_with(&format!("/{reference}"))
}

fn normalize_git_reference(value: &str) -> String {
    let mut normalized = value
        .trim()
        .replace('\\', "/")
        .trim_end_matches('/')
        .trim_end_matches(".git")
        .to_ascii_lowercase();
    if let Some(rest) = normalized
        .split_once("://")
        .map(|(_, rest)| rest.to_string())
    {
        normalized = rest;
    }
    if let Some(rest) = normalized.strip_prefix("git@") {
        normalized = rest.replacen(':', "/", 1);
    }
    normalized
}

async fn materialize_run_worktree_at(
    root: &Path,
    base_cwd: &Path,
    key: &str,
    reuse_only: bool,
) -> Result<MaterializedRunWorktree, String> {
    materialize_run_worktree_at_with_freshness(
        root,
        base_cwd,
        key,
        reuse_only,
        BaseRefFreshness::BestEffort,
    )
    .await
}

async fn materialize_run_worktree_at_with_freshness(
    root: &Path,
    base_cwd: &Path,
    key: &str,
    reuse_only: bool,
    freshness: BaseRefFreshness,
) -> Result<MaterializedRunWorktree, String> {
    let dir_name =
        run_worktree_dir_name(key).ok_or_else(|| format!("unusable worktree key {key:?}"))?;
    let path = root.join(dir_name);

    if path.exists() {
        // Linked worktrees have a `.git` file pointing at the parent repo.
        if path.join(".git").exists() {
            lock_run_worktree(base_cwd, &path, key).await;
            record_binding(root, key, base_cwd, &path)?;
            return Ok(MaterializedRunWorktree {
                path,
                base_ref: "reused".to_string(),
                reused: true,
            });
        }
        return Err(format!(
            "existing path {} is not a git worktree",
            path.display()
        ));
    }
    if reuse_only {
        return Err("resume run has no existing worktree".to_string());
    }
    if let Some(reason) = new_worktree_storage_denied_reason(root) {
        return Err(reason);
    }

    let path_arg = path.display().to_string();
    let inside = git(
        base_cwd,
        &["rev-parse", "--is-inside-work-tree"],
        GIT_LOCAL_TIMEOUT,
    )
    .await?;
    if inside != "true" {
        return Err("base workspace is not a git work tree".to_string());
    }

    let base_ref = resolve_base_ref(base_cwd, freshness).await?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("failed to create {}: {err}", parent.display()))?;
    }
    git(
        base_cwd,
        &["worktree", "add", "--detach", &path_arg, &base_ref],
        GIT_WORKTREE_ADD_TIMEOUT,
    )
    .await?;
    lock_run_worktree(base_cwd, &path, key).await;
    record_binding(root, key, base_cwd, &path)?;

    Ok(MaterializedRunWorktree {
        path,
        base_ref,
        reused: false,
    })
}

/// Best-effort `git worktree lock` as a second line of defense against manual
/// `git worktree prune/remove` while a run may be using the tree. GC unlocks
/// our own locks for non-live trees; foreign lock reasons are always honored.
async fn lock_run_worktree(base_cwd: &Path, path: &Path, key: &str) {
    let path_arg = path.display().to_string();
    let reason = format!("{LOCK_REASON_PREFIX}{key}");
    let _ = git(
        base_cwd,
        &["worktree", "lock", "--reason", &reason, &path_arg],
        GIT_LOCAL_TIMEOUT,
    )
    .await;
}

/// Pick the freshest sensible base. Remote repo summons ask origin which
/// branch is its default and require a successful progress-streaming fetch of
/// exactly that branch before the worktree is created. A slow-but-progressing
/// download is not treated as stuck: only a stall (no progress) or the
/// absolute max wall clock fails. Local repo summons use the remote default
/// branch when known and fall back to HEAD.
async fn resolve_base_ref(base_cwd: &Path, freshness: BaseRefFreshness) -> Result<String, String> {
    if matches!(freshness, BaseRefFreshness::RequireRemoteFetch) {
        return fetch_confirmed_remote_default(base_cwd).await;
    }
    let remote_branch = match git(
        base_cwd,
        &[
            "symbolic-ref",
            "--quiet",
            "--short",
            "refs/remotes/origin/HEAD",
        ],
        GIT_LOCAL_TIMEOUT,
    )
    .await
    {
        Ok(branch) => Some(branch),
        Err(_) => {
            let mut found = None;
            for candidate in ["origin/main", "origin/master"] {
                let verify = git(
                    base_cwd,
                    &["rev-parse", "--verify", "--quiet", candidate],
                    GIT_LOCAL_TIMEOUT,
                )
                .await;
                if verify.is_ok() {
                    found = Some(candidate.to_string());
                    break;
                }
            }
            found
        }
    };

    let Some(remote_branch) = remote_branch else {
        return Ok("HEAD".to_string());
    };
    if let Some(branch) = remote_branch.strip_prefix("origin/") {
        let refspec = format!("+refs/heads/{branch}:refs/remotes/origin/{branch}");
        let _ = git(
            base_cwd,
            &["fetch", "--quiet", "--no-tags", "origin", &refspec],
            GIT_FETCH_TIMEOUT,
        )
        .await;
    }
    Ok(remote_branch)
}

/// A local `origin/HEAD` may name a branch origin has since renamed or
/// deleted, so origin names the branch here, and the base is the
/// remote-tracking ref this fetch just updated.
async fn fetch_confirmed_remote_default(base_cwd: &Path) -> Result<String, String> {
    let advertised = git(
        base_cwd,
        &["ls-remote", "--symref", "origin", "HEAD"],
        GIT_FETCH_TIMEOUT,
    )
    .await?;
    let (branch, _) = crate::repo_pool::parse_ls_remote_head(&advertised).ok_or_else(|| {
        "could not resolve origin default branch: origin advertises none with a commit".to_string()
    })?;
    let tracking = format!("refs/remotes/origin/{branch}");
    let refspec = format!("+refs/heads/{branch}:{tracking}");
    let fetch_label = format!("origin/{branch}");
    git_fetch_with_progress(
        base_cwd,
        &["fetch", "--progress", "--no-tags", "origin", &refspec],
        &fetch_label,
    )
    .await?;
    // Keep the local default-branch note in step for later local summons.
    let _ = git(
        base_cwd,
        &["symbolic-ref", "refs/remotes/origin/HEAD", &tracking],
        GIT_LOCAL_TIMEOUT,
    )
    .await;
    Ok(fetch_label)
}

/// Outcome of one GC sweep, for logging.
pub struct RunWorktreeGcOutcome {
    pub apply: bool,
    pub scanned: usize,
    pub live: usize,
    pub kept: usize,
    pub reclaimed: Vec<String>,
    pub snapshotted: Vec<String>,
    pub skipped: Vec<(String, String)>,
    pub pruned_bindings: Vec<String>,
}

pub fn gc_apply_enabled() -> bool {
    gc_apply_from_env(std::env::var(RUN_WORKTREES_GC_APPLY_ENV).ok().as_deref())
}

fn gc_apply_from_env(value: Option<&str>) -> bool {
    !flag_value_disabled(value)
}

fn lru_keep_count() -> usize {
    env_u64(RUN_WORKTREES_KEEP_ENV)
        .map(|value| value as usize)
        .unwrap_or(DEFAULT_LRU_KEEP)
}

fn named_orphan_min_age() -> Duration {
    env_u64(RUN_WORKTREES_NAMED_TTL_SECS_ENV)
        .map(Duration::from_secs)
        .unwrap_or(DEFAULT_NAMED_TTL)
}

pub fn disk_warn_bytes() -> u64 {
    env_u64(WORKTREE_DISK_WARN_BYTES_ENV).unwrap_or(DEFAULT_DISK_WARN_BYTES)
}

pub fn disk_min_bytes() -> u64 {
    #[cfg(test)]
    if let Some(bytes) = TEST_DISK_MIN_BYTES.with(std::cell::Cell::get) {
        return bytes;
    }
    env_u64(WORKTREE_DISK_MIN_BYTES_ENV).unwrap_or(DEFAULT_DISK_MIN_BYTES)
}

#[cfg(test)]
pub(crate) fn set_test_disk_min_bytes(bytes: Option<u64>) {
    TEST_DISK_MIN_BYTES.with(|cell| cell.set(bytes));
}

fn env_u64(name: &str) -> Option<u64> {
    std::env::var(name)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
}

pub fn volume_available_bytes(path: &Path) -> Option<u64> {
    let mut probe = path;
    loop {
        if probe.exists() {
            return fs2::available_space(probe).ok();
        }
        probe = probe.parent()?;
    }
}

pub fn storage_allows_new_worktree(available: Option<u64>, min_bytes: u64) -> bool {
    match available {
        Some(bytes) => bytes >= min_bytes,
        None => true,
    }
}

pub fn new_worktree_storage_denied_reason(path: &Path) -> Option<String> {
    let available = volume_available_bytes(path);
    if storage_allows_new_worktree(available, disk_min_bytes()) {
        return None;
    }
    let available = available?;
    let min = disk_min_bytes();
    Some(format!(
        "machine free space {available} bytes is below the {min}-byte worktree watermark"
    ))
}

struct WorktreeGcPolicy {
    apply: bool,
    keep: usize,
    named_min_age: Duration,
}

impl WorktreeGcPolicy {
    fn opportunistic() -> Self {
        Self {
            apply: gc_apply_enabled(),
            keep: lru_keep_count(),
            named_min_age: named_orphan_min_age(),
        }
    }

    fn under_pressure() -> Self {
        Self {
            apply: true,
            keep: 0,
            named_min_age: PRESSURE_NAMED_TTL.min(named_orphan_min_age()),
        }
    }
}

/// One opportunistic GC sweep over the run-worktree pool. Live trees (a run's
/// cwd in the daemon registry) are never touched; the newest `keep` ended
/// `run-*` trees stay warm for resume; older trees and stale named linked
/// worktrees are reclaimed behind safety gates. Apply is the default;
/// `XMATRIX_RUN_WORKTREES_GC=0` is dry-run.
pub async fn gc_run_worktrees(
    live_cwds: std::collections::HashSet<PathBuf>,
) -> RunWorktreeGcOutcome {
    gc_run_worktrees_with_policy(
        &run_worktrees_root(),
        &live_cwds,
        WorktreeGcPolicy::opportunistic(),
    )
    .await
}

/// Reclaim ended trees, and sweep the repo-pool slots (L1) alongside them,
/// then any other linked tree on the machine when the owner allowed it.
/// The pool sweep is not gated on the watermark: one slot carries a whole
/// checkout plus its build output, so waiting for the volume to fall under the
/// warn mark reclaims far too late. Pressure only lowers the warm-cache budget.
pub async fn reclaim_worktree_storage_if_needed(
    live_cwds: &std::collections::HashSet<PathBuf>,
    pool_liveness: &repo_pool::PoolLiveness,
) -> RunWorktreeGcOutcome {
    let root = run_worktrees_root();
    let available = volume_available_bytes(&root);
    let under_pressure = matches!(available, Some(bytes) if bytes < disk_warn_bytes());
    let policy = if under_pressure {
        WorktreeGcPolicy::under_pressure()
    } else {
        WorktreeGcPolicy::opportunistic()
    };
    let outcome = gc_run_worktrees_with_policy(&root, live_cwds, policy).await;
    let keep_idle = if under_pressure {
        0
    } else {
        repo_pool::default_idle_keep()
    };
    repo_pool::log_pool_reclaim_outcome(
        &repo_pool::reclaim_pool_slots(pool_liveness, keep_idle).await,
    );
    // Trees xMatrix did not create wait the same named-tree floor, and only
    // once the owner turned their reclaim on.
    let foreign_min_idle = if under_pressure {
        PRESSURE_NAMED_TTL.min(named_orphan_min_age())
    } else {
        named_orphan_min_age()
    };
    if let Some(foreign) =
        crate::machine_worktrees::reclaim_foreign_worktrees_if_enabled(live_cwds, foreign_min_idle)
            .await
    {
        crate::machine_worktrees::log_foreign_reclaim_outcome(&foreign);
    }
    outcome
}

#[cfg(test)]
async fn gc_run_worktrees_at(
    root: &Path,
    live_cwds: &std::collections::HashSet<PathBuf>,
    apply: bool,
    keep: usize,
) -> RunWorktreeGcOutcome {
    gc_run_worktrees_with_policy(
        root,
        live_cwds,
        WorktreeGcPolicy {
            apply,
            keep,
            named_min_age: named_orphan_min_age(),
        },
    )
    .await
}

async fn gc_run_worktrees_with_policy(
    root: &Path,
    live_cwds: &std::collections::HashSet<PathBuf>,
    policy: WorktreeGcPolicy,
) -> RunWorktreeGcOutcome {
    let mut outcome = RunWorktreeGcOutcome {
        apply: policy.apply,
        scanned: 0,
        live: 0,
        kept: 0,
        reclaimed: Vec::new(),
        snapshotted: Vec::new(),
        skipped: Vec::new(),
        pruned_bindings: Vec::new(),
    };
    let live: std::collections::HashSet<PathBuf> = live_cwds
        .iter()
        .map(|path| path.canonicalize().unwrap_or_else(|_| path.clone()))
        .collect();
    let Ok(entries) = std::fs::read_dir(root) else {
        return outcome;
    };
    let now = std::time::SystemTime::now();
    let mut run_pool: Vec<(PathBuf, std::time::SystemTime, String)> = Vec::new();
    let mut named_pool: Vec<(PathBuf, String)> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();
        if name == BINDINGS_FILE_NAME || !path.is_dir() {
            continue;
        }
        let is_run = name.starts_with("run-");
        if !is_run && !path.join(".git").is_file() {
            continue;
        }
        outcome.scanned += 1;
        if !path.join(".git").is_file() {
            outcome
                .skipped
                .push((name, "not a linked git worktree".to_string()));
            continue;
        }
        let canonical = path.canonicalize().unwrap_or_else(|_| path.clone());
        // A live run's cwd may be the tree itself or a subdirectory of it.
        if live.iter().any(|cwd| cwd.starts_with(&canonical)) {
            outcome.live += 1;
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .unwrap_or(std::time::UNIX_EPOCH);
        if is_run {
            run_pool.push((path, modified, name));
            continue;
        }
        let age = now.duration_since(modified).unwrap_or(Duration::ZERO);
        if age < policy.named_min_age {
            outcome.kept += 1;
            continue;
        }
        named_pool.push((path, name));
    }
    // Newest first; name as a deterministic tie-breaker.
    run_pool.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.2.cmp(&b.2)));
    outcome.kept += run_pool.len().min(policy.keep);
    let mut candidates: Vec<(PathBuf, String)> = run_pool
        .into_iter()
        .skip(policy.keep)
        .map(|(path, _, name)| (path, name))
        .collect();
    candidates.extend(named_pool);
    for (path, name) in candidates {
        match reclaim_run_worktree(&path, policy.apply).await {
            Ok(snapshotted) => {
                if snapshotted {
                    outcome.snapshotted.push(name.clone());
                }
                outcome.reclaimed.push(name);
            }
            Err(reason) => outcome.skipped.push((name, reason)),
        }
    }
    if let Ok(pruned) = prune_stale_bindings(root, policy.apply) {
        outcome.pruned_bindings = pruned;
    }
    outcome
}

fn prune_stale_bindings(root: &Path, apply: bool) -> Result<Vec<String>, String> {
    let mut bindings = load_bindings(root)?;
    let stale: Vec<String> = bindings
        .bindings
        .iter()
        .filter(|(_, binding)| !Path::new(&binding.path).exists())
        .map(|(key, _)| key.clone())
        .collect();
    if apply && !stale.is_empty() {
        for key in &stale {
            bindings.bindings.remove(key);
        }
        save_bindings(root, &bindings)?;
    }
    Ok(stale)
}

/// Reclaim one ended-run worktree (or report what would happen in dry-run).
/// Safety gates: foreign locks are honored; a dirty tree or one with commits
/// unreachable from any remote gets its WIP committed and pinned to
/// `refs/xmatrix/snapshot/<dir>` before removal, so no un-landed work is ever
/// lost. Any git failure skips the tree conservatively.
pub async fn reclaim_run_worktree(path: &Path, apply: bool) -> Result<bool, String> {
    let dir_name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .ok_or_else(|| "worktree path has no directory name".to_string())?;
    reclaim_linked_worktree(path, apply, &dir_name).await
}

/// [`reclaim_run_worktree`] with the snapshot pinned to
/// `refs/xmatrix/snapshot/<snapshot_name>`. Trees the daemon did not create
/// can share a directory name, so they pass a name that cannot collide.
pub(crate) async fn reclaim_linked_worktree(
    path: &Path,
    apply: bool,
    snapshot_name: &str,
) -> Result<bool, String> {
    if let Some(reason) = worktree_lock_reason(path).await?
        && !reason.starts_with(LOCK_REASON_PREFIX)
    {
        return Err(format!("locked: {reason}"));
    }
    let dirty = !git(path, &["status", "--porcelain"], GIT_LOCAL_TIMEOUT)
        .await?
        .is_empty();
    let unpushed = git(
        path,
        &["rev-list", "--count", "HEAD", "--not", "--remotes"],
        GIT_LOCAL_TIMEOUT,
    )
    .await?
    .parse::<u64>()
    .map_err(|err| format!("unparseable rev-list count: {err}"))?
        > 0;
    let needs_snapshot = dirty || unpushed;
    let main_worktree = main_worktree_of(path).await?;
    if !apply {
        return Ok(needs_snapshot);
    }
    if needs_snapshot {
        if dirty {
            git(path, &["add", "-A"], GIT_GC_MUTATION_TIMEOUT).await?;
            git(
                path,
                &[
                    "-c",
                    "user.name=xmatrix-daemon",
                    "-c",
                    "user.email=daemon@xmatrix.local",
                    "commit",
                    "--quiet",
                    "--no-verify",
                    "--allow-empty",
                    "-m",
                    "xmatrix: run worktree snapshot before reclaim",
                ],
                GIT_GC_MUTATION_TIMEOUT,
            )
            .await?;
        }
        let snapshot_ref = format!("refs/xmatrix/snapshot/{snapshot_name}");
        git(
            path,
            &["update-ref", &snapshot_ref, "HEAD"],
            GIT_LOCAL_TIMEOUT,
        )
        .await?;
    }
    let path_arg = path.display().to_string();
    // Drop our own lock so removal isn't refused; failure is fine (unlocked).
    let _ = git(
        &main_worktree,
        &["worktree", "unlock", &path_arg],
        GIT_LOCAL_TIMEOUT,
    )
    .await;
    let mut remove_args = vec!["worktree", "remove"];
    if needs_snapshot {
        remove_args.push("--force");
    }
    remove_args.push(&path_arg);
    git(&main_worktree, &remove_args, GIT_GC_MUTATION_TIMEOUT).await?;
    Ok(needs_snapshot)
}

/// The lock reason for a linked worktree, if locked. Reads the `locked` file
/// in the worktree's admin directory.
async fn worktree_lock_reason(path: &Path) -> Result<Option<String>, String> {
    let admin_dir = git(
        path,
        &["rev-parse", "--absolute-git-dir"],
        GIT_LOCAL_TIMEOUT,
    )
    .await?;
    let locked = Path::new(&admin_dir).join("locked");
    if !locked.exists() {
        return Ok(None);
    }
    Ok(Some(
        std::fs::read_to_string(&locked)
            .map(|reason| reason.trim().to_string())
            .unwrap_or_default(),
    ))
}

/// The repository's main working tree (first entry of `git worktree list`),
/// used as the cwd for `git worktree unlock/remove`.
async fn main_worktree_of(path: &Path) -> Result<PathBuf, String> {
    let listing = git(
        path,
        &["worktree", "list", "--porcelain"],
        GIT_LOCAL_TIMEOUT,
    )
    .await?;
    listing
        .lines()
        .find_map(|line| line.strip_prefix("worktree "))
        .map(|main| PathBuf::from(main.trim()))
        .ok_or_else(|| "could not resolve main worktree".to_string())
}

pub fn log_gc_outcome(outcome: &RunWorktreeGcOutcome) {
    if outcome.reclaimed.is_empty()
        && outcome.skipped.is_empty()
        && outcome.pruned_bindings.is_empty()
    {
        return;
    }
    let verb = if outcome.apply {
        "reclaimed"
    } else {
        "would reclaim (dry-run; set XMATRIX_RUN_WORKTREES_GC=0 to keep dry-run)"
    };
    eprintln!(
        "run worktree gc: scanned {} (live {}, kept {}), {verb} {:?} (snapshotted {:?}), skipped {:?}, stale bindings {:?}",
        outcome.scanned,
        outcome.live,
        outcome.kept,
        outcome.reclaimed,
        outcome.snapshotted,
        outcome.skipped,
        outcome.pruned_bindings
    );
}

pub(crate) async fn git(cwd: &Path, args: &[&str], timeout: Duration) -> Result<String, String> {
    command_output("git", args, repo_pool::git_command(cwd, args), timeout).await
}

/// The branch namespace a cross-machine handoff may push to. Anything else is
/// refused, so a handoff can never overwrite a branch someone works on.
pub fn valid_handoff_branch(branch: &str) -> bool {
    branch.strip_prefix("xmatrix/handoff/").is_some_and(|name| {
        !name.is_empty()
            && name.len() <= 120
            && name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
            && !name.contains("..")
            && !name.ends_with('.')
            && !name.ends_with(".lock")
    })
}

/// Everything a stopped Run's checkout holds, committed or not, as one commit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HandoffWork {
    pub base: String,
    pub commit: String,
    pub dirty: bool,
}

/// Capture `cwd`'s tracked and untracked changes (ignored files stay out) on
/// top of its `HEAD`, without touching the checkout or its index: a scratch
/// index stages them, and the commit is written straight to the object store.
/// A clean checkout yields `HEAD` itself, which still carries unpushed commits.
pub async fn capture_handoff_work(cwd: &Path, label: &str) -> Result<HandoffWork, String> {
    let base = git(
        cwd,
        &["rev-parse", "--verify", "HEAD^{commit}"],
        GIT_LOCAL_TIMEOUT,
    )
    .await?;
    let base = base.trim().to_string();
    let index =
        std::env::temp_dir().join(format!("xmatrix-handoff-{}.index", uuid::Uuid::new_v4()));
    let staged = async {
        let scratch = |args: &'static [&'static str]| {
            let mut command = repo_pool::git_command(cwd, args);
            command.env("GIT_INDEX_FILE", &index);
            command_output("git", args, command, GIT_HANDOFF_TIMEOUT)
        };
        scratch(&["read-tree", "HEAD"]).await?;
        scratch(&["add", "--all", "--", "."]).await?;
        scratch(&["write-tree"]).await
    }
    .await;
    let _ = std::fs::remove_file(&index);
    let tree = staged?.trim().to_string();
    let head_tree = git(
        cwd,
        &["rev-parse", "--verify", "HEAD^{tree}"],
        GIT_LOCAL_TIMEOUT,
    )
    .await?;
    if tree == head_tree.trim() {
        return Ok(HandoffWork {
            commit: base.clone(),
            base,
            dirty: false,
        });
    }
    let message = format!("xMatrix handoff: uncommitted work of {label}");
    let args = [
        "commit-tree",
        tree.as_str(),
        "-p",
        base.as_str(),
        "-m",
        message.as_str(),
    ];
    let mut command = repo_pool::git_command(cwd, &args);
    // A daemon has no Git identity of its own; the commit says who wrote it.
    for (key, value) in [
        ("GIT_AUTHOR_NAME", "xMatrix"),
        ("GIT_AUTHOR_EMAIL", "handoff@xmatrix.sh"),
        ("GIT_COMMITTER_NAME", "xMatrix"),
        ("GIT_COMMITTER_EMAIL", "handoff@xmatrix.sh"),
    ] {
        command.env(key, value);
    }
    let commit = command_output("git", &args, command, GIT_LOCAL_TIMEOUT).await?;
    Ok(HandoffWork {
        base,
        commit: commit.trim().to_string(),
        dirty: true,
    })
}

/// Push a captured commit to `branch` on `origin`. The namespace is ours and
/// the name is per handoff, so a retry of the same handoff may move it.
pub async fn push_handoff_work(cwd: &Path, commit: &str, branch: &str) -> Result<(), String> {
    if !valid_handoff_branch(branch) {
        return Err(format!(
            "handoff branch {branch:?} is outside xmatrix/handoff/"
        ));
    }
    let refspec = format!("+{commit}:refs/heads/{branch}");
    git(
        cwd,
        &["push", "--no-verify", "origin", refspec.as_str()],
        GIT_HANDOFF_TIMEOUT,
    )
    .await
    .map(|_| ())
}

/// Stream a git fetch with progress so callers can tell "downloading" from
/// "stuck". Stall timeout applies only when no progress is observed; a slow
/// but active download is allowed up to [`GIT_FETCH_MAX_TIMEOUT`].
async fn git_fetch_with_progress(cwd: &Path, args: &[&str], label: &str) -> Result<String, String> {
    let mut command = repo_pool::git_command(cwd, args);
    // Force progress on non-TTY daemon pipes; `--progress` alone can still
    // be suppressed when stderr is not a terminal.
    command.env("GIT_PROGRESS_DELAY", "0");
    command_output_with_progress(
        "git",
        args,
        command,
        GIT_FETCH_STALL_TIMEOUT,
        GIT_FETCH_MAX_TIMEOUT,
        label,
    )
    .await
}

async fn git_no_cwd(args: &[&str], timeout: Duration) -> Result<String, String> {
    let mut command = repo_pool::background_git_command();
    command.args(args);
    command_output("git", args, command, timeout).await
}

async fn gh(args: &[&str], timeout: Duration) -> Result<String, String> {
    let mut command = tokio::process::Command::new("gh");
    process_tree::hide_tokio_console_window(&mut command);
    command.args(args).stdin(std::process::Stdio::null());
    command_output("gh", args, command, timeout).await
}

fn spawn_guarded_command(
    program: &str,
    args: &[&str],
    mut command: tokio::process::Command,
) -> Result<(tokio::process::Child, process_tree::ProcessTreeGuard), String> {
    command
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    process_tree::configure_tokio_process_tree(&mut command);
    let mut child = command
        .spawn()
        .map_err(|err| format!("{program} {} failed to start: {err}", args.join(" ")))?;
    let process_tree = process_tree::guard_tokio_child(&mut child).map_err(|err| {
        format!(
            "{program} {} process-tree setup failed: {err}",
            args.join(" ")
        )
    })?;
    Ok((child, process_tree))
}

async fn command_output(
    program: &str,
    args: &[&str],
    command: tokio::process::Command,
    timeout: Duration,
) -> Result<String, String> {
    let (child, mut process_tree) = spawn_guarded_command(program, args, command)?;
    let output = match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(result) => {
            result.map_err(|err| format!("{program} {} wait failed: {err}", args.join(" ")))?
        }
        Err(_) => {
            let _ = process_tree.terminate();
            return Err(format!(
                "{program} {} timed out after {:?}",
                args.join(" "),
                timeout
            ));
        }
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "{program} {} failed: {}",
            args.join(" "),
            stderr.trim().lines().last().unwrap_or("unknown error")
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Run a command while streaming stderr/stdout progress. Distinguishes:
/// - **stall**: no progress for `stall_timeout` (looks stuck)
/// - **max wall clock**: still progressing but exceeded `max_timeout`
///
/// Git progress often uses carriage returns; each completed progress fragment
/// resets the stall clock and is rate-limited into daemon logs.
async fn command_output_with_progress(
    program: &str,
    args: &[&str],
    command: tokio::process::Command,
    stall_timeout: Duration,
    max_timeout: Duration,
    label: &str,
) -> Result<String, String> {
    let (mut child, mut process_tree) = spawn_guarded_command(program, args, command)?;

    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let joined_args = args.join(" ");
    eprintln!(
        "{} git fetch starting ({label}): {program} {joined_args}",
        "↓".cyan()
    );

    let mut stdout_buf = Vec::new();
    let mut stderr_buf = Vec::new();
    let mut stdout_tmp = [0u8; 4096];
    let mut stderr_tmp = [0u8; 4096];
    let mut progress_pending = Vec::new();
    let mut last_progress: Option<String> = None;
    let mut saw_progress = false;
    let mut last_log_at = std::time::Instant::now()
        .checked_sub(GIT_PROGRESS_LOG_INTERVAL)
        .unwrap_or_else(std::time::Instant::now);
    let started = std::time::Instant::now();
    let mut last_activity = started;
    let max_deadline = tokio::time::Instant::now() + max_timeout;

    let status = loop {
        let stall_remaining = stall_timeout.saturating_sub(last_activity.elapsed());
        let stall_deadline = tokio::time::Instant::now() + stall_remaining;
        let wait_deadline = stall_deadline.min(max_deadline);

        tokio::select! {
            biased;
            status = child.wait() => {
                break status.map_err(|err| {
                    format!("{program} {joined_args} wait failed: {err}")
                })?;
            }
            result = async {
                match stderr.as_mut() {
                    Some(pipe) => pipe.read(&mut stderr_tmp).await,
                    None => std::future::pending().await,
                }
            } => {
                match result {
                    Ok(0) => {
                        stderr = None;
                    }
                    Ok(n) => {
                        stderr_buf.extend_from_slice(&stderr_tmp[..n]);
                        last_activity = std::time::Instant::now();
                        for fragment in
                            progress_fragments_from_bytes(&stderr_tmp[..n], &mut progress_pending)
                        {
                            saw_progress = true;
                            last_progress = Some(fragment.clone());
                            if last_log_at.elapsed() >= GIT_PROGRESS_LOG_INTERVAL {
                                eprintln!(
                                    "{} git fetch progress ({label}): {fragment}",
                                    "↓".cyan()
                                );
                                last_log_at = std::time::Instant::now();
                            }
                        }
                    }
                    Err(err) => {
                        return Err(format!(
                            "{program} {joined_args} stderr read failed: {err}"
                        ));
                    }
                }
            }
            result = async {
                match stdout.as_mut() {
                    Some(pipe) => pipe.read(&mut stdout_tmp).await,
                    None => std::future::pending().await,
                }
            } => {
                match result {
                    Ok(0) => {
                        stdout = None;
                    }
                    Ok(n) => {
                        stdout_buf.extend_from_slice(&stdout_tmp[..n]);
                        last_activity = std::time::Instant::now();
                    }
                    Err(err) => {
                        return Err(format!(
                            "{program} {joined_args} stdout read failed: {err}"
                        ));
                    }
                }
            }
            _ = tokio::time::sleep_until(wait_deadline) => {
                if started.elapsed() >= max_timeout {
                    let _ = process_tree.terminate();
                    let detail = last_progress
                        .as_deref()
                        .map(|line| format!("; last progress: {line}"))
                        .unwrap_or_else(|| {
                            if saw_progress {
                                String::new()
                            } else {
                                "; no progress output observed".to_string()
                            }
                        });
                    return Err(format!(
                        "{program} {joined_args} exceeded max fetch time {:?} while still active{detail}",
                        max_timeout
                    ));
                }
                if last_activity.elapsed() >= stall_timeout {
                    let _ = process_tree.terminate();
                    let detail = last_progress
                        .as_deref()
                        .map(|line| format!("; last progress: {line}"))
                        .unwrap_or_else(|| "; no progress output observed".to_string());
                    return Err(format!(
                        "{program} {joined_args} stalled for {:?} with no download progress{detail}",
                        stall_timeout
                    ));
                }
            }
        }
    };

    // Drain any remaining pipes after exit.
    if let Some(mut pipe) = stdout.take() {
        let mut rest = Vec::new();
        let _ = pipe.read_to_end(&mut rest).await;
        stdout_buf.extend_from_slice(&rest);
    }
    if let Some(mut pipe) = stderr.take() {
        let mut rest = Vec::new();
        let _ = pipe.read_to_end(&mut rest).await;
        stderr_buf.extend_from_slice(&rest);
        for fragment in progress_fragments_from_bytes(&rest, &mut progress_pending) {
            last_progress = Some(fragment);
            saw_progress = true;
        }
    }
    if let Some(fragment) = finalize_progress_fragment(&mut progress_pending) {
        last_progress = Some(fragment.clone());
        saw_progress = true;
        eprintln!("{} git fetch progress ({label}): {fragment}", "↓".cyan());
    }

    if !status.success() {
        let stderr = String::from_utf8_lossy(&stderr_buf);
        return Err(format!(
            "{program} {joined_args} failed: {}",
            stderr
                .trim()
                .lines()
                .last()
                .or(last_progress.as_deref())
                .unwrap_or("unknown error")
        ));
    }

    if saw_progress {
        eprintln!(
            "{} git fetch complete ({label}) in {:.1}s{}",
            "✓".green().bold(),
            started.elapsed().as_secs_f32(),
            last_progress
                .as_deref()
                .map(|line| format!("; {line}"))
                .unwrap_or_default()
        );
    } else {
        eprintln!(
            "{} git fetch complete ({label}) in {:.1}s (no progress lines; already up to date?)",
            "✓".green().bold(),
            started.elapsed().as_secs_f32()
        );
    }

    Ok(String::from_utf8_lossy(&stdout_buf).trim().to_string())
}

/// Split a byte chunk into progress fragments. Git progress often uses `\r`
/// for in-place updates and `\n` for completed lines.
fn progress_fragments_from_bytes(bytes: &[u8], pending: &mut Vec<u8>) -> Vec<String> {
    let mut out = Vec::new();
    for &byte in bytes {
        match byte {
            b'\n' | b'\r' => {
                if let Some(fragment) = finalize_progress_fragment(pending) {
                    out.push(fragment);
                }
            }
            _ => pending.push(byte),
        }
    }
    out
}

fn finalize_progress_fragment(pending: &mut Vec<u8>) -> Option<String> {
    if pending.is_empty() {
        return None;
    }
    let text = String::from_utf8_lossy(pending);
    let cleaned: String = text
        .chars()
        .filter(|ch| !ch.is_control() || *ch == '\t')
        .collect::<String>()
        .trim()
        .to_string();
    pending.clear();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    include!("../../core/tests/support/fs_cleanup.rs");

    use crate::test_support::*;

    fn update_remote_readme(seed: &Path, contents: &str) {
        std::fs::write(seed.join("README.md"), contents).unwrap();
        run_git(seed, &["add", "."]);
        run_git(seed, &["commit", "--quiet", "-m", "latest"]);
        run_git(seed, &["push", "--quiet", "origin", "main"]);
    }

    fn clone_remote(remote: &str, checkout: &Path) {
        run_git_no_cwd(&["clone", "--quiet", remote, &checkout.display().to_string()]);
    }

    #[test]
    fn flag_parsing_matches_env_flag_semantics() {
        assert!(flag_value_enabled(Some("1")));
        assert!(flag_value_enabled(Some("true")));
        assert!(flag_value_enabled(Some(" ON ")));
        assert!(!flag_value_enabled(Some("0")));
        assert!(!flag_value_enabled(Some("")));
        assert!(!flag_value_enabled(None));
    }

    #[test]
    fn gc_applies_unless_explicitly_disabled() {
        assert!(gc_apply_from_env(None));
        assert!(gc_apply_from_env(Some("1")));
        assert!(!gc_apply_from_env(Some("0")));
        assert!(!gc_apply_from_env(Some("false")));
        assert!(!gc_apply_from_env(Some("off")));
    }

    #[test]
    fn disk_watermark_denies_only_when_measured_free_space_is_below_min() {
        assert!(storage_allows_new_worktree(
            Some(DEFAULT_DISK_MIN_BYTES),
            DEFAULT_DISK_MIN_BYTES
        ));
        assert!(!storage_allows_new_worktree(
            Some(DEFAULT_DISK_MIN_BYTES - 1),
            DEFAULT_DISK_MIN_BYTES
        ));
        assert!(storage_allows_new_worktree(None, DEFAULT_DISK_MIN_BYTES));
    }

    #[test]
    fn spawn_trigger_is_marker_driven_with_env_override() {
        // Unset env: the Hub's repo-summon marker decides.
        assert!(spawn_enabled_from(true, None));
        assert!(!spawn_enabled_from(false, None));
        // Kill-switch beats the marker.
        assert!(!spawn_enabled_from(true, Some("0")));
        assert!(!spawn_enabled_from(true, Some("off")));
        // Legacy force-all still works for testing.
        assert!(spawn_enabled_from(false, Some("1")));
        // Unrecognized values behave like unset.
        assert!(spawn_enabled_from(true, Some("maybe")));
        assert!(!spawn_enabled_from(false, Some("maybe")));
    }

    #[test]
    fn dir_name_is_hashed_deterministic_and_collision_free_on_shared_prefixes() {
        let a = run_worktree_dir_name("user-1:channel-1:instance-1").expect("name");
        let b = run_worktree_dir_name("user-1:channel-1:instance-2").expect("name");
        assert_eq!(
            a,
            run_worktree_dir_name("user-1:channel-1:instance-1").unwrap()
        );
        // Session keys share long id prefixes; hashing must still separate them.
        assert_ne!(a, b);
        assert!(a.starts_with("run-") && a.len() == 4 + 12, "{a}");
        assert_eq!(run_worktree_dir_name("   ").as_deref(), None);
        assert_eq!(run_worktree_dir_name("").as_deref(), None);
    }

    #[test]
    fn remote_repo_reference_helpers_match_common_git_urls() {
        assert_eq!(
            clean_remote_repo_ref(" xmatrix/example-repo.git "),
            Some("xmatrix/example-repo".to_string())
        );
        assert_eq!(
            clone_url_for_repo_ref("xmatrix/example-repo"),
            "https://github.com/xmatrix/example-repo.git"
        );
        assert_eq!(
            clone_url_for_repo_ref("git@github.com:xmatrix/example-repo.git"),
            "git@github.com:xmatrix/example-repo.git"
        );
        assert!(git_reference_matches(
            "xmatrix/example-repo",
            "https://github.com/xmatrix/example-repo.git"
        ));
        assert!(git_reference_matches(
            "xmatrix/example-repo",
            "git@github.com:xmatrix/example-repo.git"
        ));
        assert!(!git_reference_matches(
            "xmatrix/example-repo",
            "https://github.com/other/example-repo.git"
        ));
    }

    #[tokio::test]
    async fn materializes_detached_worktree_and_reuses_it() {
        if !git_available() {
            return;
        }
        let base = unique_temp_dir("base");
        let root = unique_temp_dir("root");
        init_repo_with_commit(&base);

        // No remote in this repo: materialization falls back to local HEAD.
        let result = materialize_run_worktree_at(&root, &base, "run-id-1234abcd", false).await;
        let materialized = result.expect("materialization should succeed");
        assert!(!materialized.reused);
        assert_eq!(materialized.base_ref, "HEAD");
        assert_eq!(
            materialized.path,
            root.join(run_worktree_dir_name("run-id-1234abcd").unwrap())
        );
        assert!(materialized.path.join(".git").is_file());
        assert!(materialized.path.join("README.md").is_file());

        let reused = materialize_run_worktree_at(&root, &base, "run-id-1234abcd", true).await;
        let reused = reused.expect("existing worktree should be reused");
        assert!(reused.reused);
        assert_eq!(reused.path, materialized.path);

        cleanup_test_dirs(&[&root, &base]);
    }

    #[tokio::test]
    async fn missing_registered_run_worktree_is_not_repaired_implicitly() {
        if !git_available() {
            return;
        }
        let base = unique_temp_dir("restart-base");
        let root = unique_temp_dir("restart-root");
        init_repo_with_commit(&base);

        let initial = materialize_run_worktree_at(&root, &base, "restart-run-1234", false)
            .await
            .expect("initial worktree");
        assert!(
            resume_reuse_only_at(&root, "restart-run-1234", true, true)
                .expect("read durable worktree binding"),
            "a successful materialization must persist a reuse-only binding"
        );
        std::fs::remove_dir_all(&initial.path).expect("remove interrupted worktree");

        let result = materialize_run_worktree_at(&root, &base, "restart-run-1234", true).await;
        assert!(
            result.is_err(),
            "missing registered worktree must require explicit repair"
        );
        assert!(
            !initial.path.exists(),
            "implicit recovery must not recreate or otherwise mutate the missing path"
        );
        let listing = git_command()
            .arg("-C")
            .arg(&base)
            .args(["worktree", "list", "--porcelain"])
            .output()
            .expect("list worktrees");
        assert!(listing.status.success());
        let worktree_dir = run_worktree_dir_name("restart-run-1234").unwrap();
        assert!(
            String::from_utf8_lossy(&listing.stdout).contains(&worktree_dir),
            "implicit recovery must not prune the administrative worktree record"
        );

        cleanup_test_dirs(&[&root, &base]);
    }

    #[test]
    fn legacy_reborn_without_a_durable_binding_may_bootstrap_once() {
        let root = unique_temp_dir("legacy-bootstrap-root");
        assert!(
            !resume_reuse_only_at(&root, "legacy-run-1234", true, true)
                .expect("read missing durable worktree binding"),
            "a historical run with no local materialization record may bootstrap"
        );
        assert!(
            resume_reuse_only_at(&root, "legacy-run-1234", true, false)
                .expect("read strict resume policy"),
            "ordinary resumes must remain reuse-only"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    fn remote_materialization_fixture() -> (PathBuf, PathBuf, PathBuf, PathBuf) {
        let remote = unique_temp_dir("remote-bare");
        let seed = unique_temp_dir("remote-seed");
        let base = unique_temp_dir("remote-base");
        let root = unique_temp_dir("remote-root");
        let remote_arg = seed_remote(&remote, &seed);
        clone_remote(&remote_arg, &base);
        (remote, seed, base, root)
    }

    #[tokio::test]
    async fn remote_repo_materialization_fetches_latest_origin_branch() {
        if !git_available() {
            return;
        }
        let (remote, seed, base, root) = remote_materialization_fixture();

        update_remote_readme(&seed, "latest\n");
        assert_eq!(
            std::fs::read_to_string(base.join("README.md"))
                .unwrap()
                .trim_end(),
            "hello"
        );

        let materialized = materialize_run_worktree_at_with_freshness(
            &root,
            &base,
            "remote-latest-run",
            false,
            BaseRefFreshness::RequireRemoteFetch,
        )
        .await
        .expect("remote materialization should fetch latest origin branch");

        assert_eq!(materialized.base_ref, "origin/main");
        assert_eq!(
            std::fs::read_to_string(materialized.path.join("README.md"))
                .unwrap()
                .trim_end(),
            "latest"
        );

        cleanup_test_dirs(&[&root, &base, &seed, &remote]);
    }

    #[tokio::test]
    async fn remote_repo_materialization_follows_a_renamed_default_branch() {
        if !git_available() {
            return;
        }
        let (remote, seed, base, root) = remote_materialization_fixture();

        // Origin renames main to trunk; the checkout still notes origin/HEAD -> origin/main.
        run_git(&seed, &["checkout", "--quiet", "-b", "trunk"]);
        std::fs::write(seed.join("README.md"), "trunk\n").unwrap();
        run_git(&seed, &["commit", "--quiet", "-am", "trunk"]);
        run_git(&seed, &["push", "--quiet", "origin", "trunk"]);
        run_git(&remote, &["symbolic-ref", "HEAD", "refs/heads/trunk"]);
        run_git(&remote, &["update-ref", "-d", "refs/heads/main"]);

        let materialized = materialize_run_worktree_at_with_freshness(
            &root,
            &base,
            "remote-renamed-run",
            false,
            BaseRefFreshness::RequireRemoteFetch,
        )
        .await
        .expect("remote materialization should follow origin's default branch");

        assert_eq!(materialized.base_ref, "origin/trunk");
        assert_eq!(
            std::fs::read_to_string(materialized.path.join("README.md"))
                .unwrap()
                .trim_end(),
            "trunk"
        );

        cleanup_test_dirs(&[&root, &base, &seed, &remote]);
    }

    #[tokio::test]
    async fn remote_repo_materialization_prefers_existing_checkout_candidate() {
        if !git_available() {
            return;
        }
        let remote = unique_temp_dir("candidate-remote-bare");
        let seed = unique_temp_dir("candidate-remote-seed");
        let selected = unique_temp_dir("candidate-selected");
        let existing = unique_temp_dir("candidate-existing");
        let root = unique_temp_dir("candidate-root");

        let remote_arg = seed_remote(&remote, &seed);

        init_repo_with_commit(&selected);
        clone_remote(&remote_arg, &existing);

        update_remote_readme(&seed, "latest from remote\n");

        let materialized = materialize_run_worktree_for_remote_at(
            &root,
            &selected,
            std::slice::from_ref(&existing),
            &remote_arg,
            "remote-existing-candidate-run",
            false,
        )
        .await
        .expect("remote materialization should use registered existing checkout");

        let main_worktree = main_worktree_of(&materialized.path)
            .await
            .expect("main worktree");
        assert_eq!(
            main_worktree.canonicalize().unwrap(),
            existing.canonicalize().unwrap()
        );
        assert_eq!(materialized.base_ref, "origin/main");
        assert_eq!(
            std::fs::read_to_string(materialized.path.join("README.md"))
                .unwrap()
                .trim_end(),
            "latest from remote"
        );

        cleanup_test_dirs(&[&root, &existing, &selected, &seed, &remote]);
    }

    #[tokio::test]
    async fn remote_repo_materialization_fails_before_worktree_when_remote_inaccessible() {
        if !git_available() {
            return;
        }
        let selected = unique_temp_dir("inaccessible-selected");
        let root = unique_temp_dir("inaccessible-root");
        let missing_remote = unique_temp_dir("inaccessible-remote");
        std::fs::remove_dir_all(&missing_remote).unwrap();
        init_repo_with_commit(&selected);

        let result = materialize_run_worktree_for_remote_at(
            &root,
            &selected,
            &[],
            &missing_remote.display().to_string(),
            "remote-inaccessible-run",
            false,
        )
        .await;
        let err = match result {
            Ok(_) => panic!("inaccessible remote must fail before materializing"),
            Err(err) => err,
        };

        assert!(err.contains("is not accessible"), "{err}");
        assert!(
            !root
                .join(run_worktree_dir_name("remote-inaccessible-run").unwrap())
                .exists()
        );

        cleanup_test_dirs(&[&root, &selected]);
    }

    #[tokio::test]
    async fn managed_repo_checkout_coordinator_serializes_materialization() {
        let repos_root = unique_temp_dir("managed-checkout-coordinator");
        let managed_repo = repos_root.join("owner-repo");
        let holder = acquire_managed_repo_checkout_guard(&managed_repo)
            .await
            .expect("acquire initial managed checkout coordinator");

        let other_repo = repos_root.join("other-repo");
        let other = tokio::time::timeout(
            Duration::from_millis(250),
            acquire_managed_repo_checkout_guard(&other_repo),
        )
        .await
        .expect("different repositories must materialize in parallel")
        .expect("different-repo checkout coordinator must be independent");
        drop(other);

        let waiting_repo = managed_repo.clone();
        let waiter =
            tokio::spawn(async move { acquire_managed_repo_checkout_guard(&waiting_repo).await });
        tokio::time::sleep(Duration::from_millis(75)).await;
        assert!(
            !waiter.is_finished(),
            "a concurrent first-clone attempt must wait for the current materialization"
        );

        drop(holder);
        let acquired = tokio::time::timeout(Duration::from_secs(2), waiter)
            .await
            .expect("waiter should acquire after release")
            .expect("waiter task should not fail")
            .expect("managed checkout contention must not fail a concurrent launch");
        drop(acquired);
        assert!(!repos_root.join(".locks").exists());

        let _ = std::fs::remove_dir_all(&repos_root);
    }

    #[test]
    fn progress_fragments_split_on_cr_and_lf() {
        let mut pending = Vec::new();
        let first = progress_fragments_from_bytes(b"Receiving objects:  10%\r", &mut pending);
        assert_eq!(first, vec!["Receiving objects:  10%".to_string()]);
        let second =
            progress_fragments_from_bytes(b"Receiving objects:  50%\nDone\n", &mut pending);
        assert_eq!(
            second,
            vec!["Receiving objects:  50%".to_string(), "Done".to_string()]
        );
        assert!(pending.is_empty());
    }

    #[test]
    fn progress_fragments_keep_incomplete_tail() {
        let mut pending = Vec::new();
        let none = progress_fragments_from_bytes(b"Receiving objects:  7", &mut pending);
        assert!(none.is_empty());
        assert_eq!(String::from_utf8_lossy(&pending), "Receiving objects:  7");
        let finished = progress_fragments_from_bytes(b"5%\r", &mut pending);
        assert_eq!(finished, vec!["Receiving objects:  75%".to_string()]);
    }

    #[tokio::test]
    async fn progress_command_fails_on_stall_without_output() {
        // A command that produces no output and never exits should hit the
        // stall timeout (not the max wall clock).
        #[cfg(windows)]
        let (program, args): (&str, &[&str]) = (
            "powershell",
            &["-NoProfile", "-Command", "Start-Sleep -Seconds 30"],
        );
        #[cfg(not(windows))]
        let (program, args): (&str, &[&str]) = ("sleep", &["30"]);
        let mut command = tokio::process::Command::new(program);
        command.args(args);
        let err = command_output_with_progress(
            program,
            args,
            command,
            Duration::from_millis(200),
            Duration::from_secs(5),
            "stall-test",
        )
        .await
        .expect_err("sleep without progress must stall");
        assert!(
            err.contains("stalled") && err.contains("no download progress"),
            "unexpected error: {err}"
        );
    }

    #[tokio::test]
    async fn progress_command_resets_stall_when_stderr_keeps_flowing() {
        // Use cmd.exe here rather than PowerShell: PowerShell's own cold start
        // can exceed the stall interval before the child script has emitted a
        // byte, which tests process startup rather than stream progress. The
        // five one-second stderr updates span well beyond the 1.7s stall
        // bound, so success proves each observed update renews that bound.
        #[cfg(windows)]
        let (program, args): (&str, Vec<&str>) = (
            "cmd",
            vec![
                "/Q",
                "/C",
                "echo chunk start 1>&2 & (for %i in (1 2 3 4 5) do (ping -n 2 127.0.0.1 >nul & echo chunk %i 1>&2)) & echo ok",
            ],
        );
        #[cfg(not(windows))]
        let (program, args): (&str, Vec<&str>) = (
            "sh",
            vec![
                "-c",
                "echo 'chunk start' >&2; for i in 1 2 3 4 5; do sleep 0.15; echo \"chunk $i\" >&2; done; echo ok",
            ],
        );
        let mut command = tokio::process::Command::new(program);
        command.args(&args);
        let out = command_output_with_progress(
            program,
            &args,
            command,
            Duration::from_millis(1_700),
            Duration::from_secs(8),
            "flowing-test",
        )
        .await
        .expect("progressing command must not stall");
        assert_eq!(out.trim(), "ok");
    }

    #[tokio::test]
    async fn linked_worktrees_are_detected_and_main_checkouts_are_not() {
        if !git_available() {
            return;
        }
        let base = unique_temp_dir("linked-base");
        let root = unique_temp_dir("linked-root");
        init_repo_with_commit(&base);
        assert!(!is_linked_git_worktree(&base));
        let tree = materialize_run_worktree_at(&root, &base, "linked-run-0001", false)
            .await
            .expect("materialize");
        assert!(is_linked_git_worktree(&tree.path));
        let plain = unique_temp_dir("linked-plain");
        assert!(!is_linked_git_worktree(&plain));

        cleanup_test_dirs(&[&root, &base, &plain]);
    }

    #[tokio::test]
    async fn resume_without_existing_worktree_is_an_error() {
        if !git_available() {
            return;
        }
        let base = unique_temp_dir("resume-base");
        let root = unique_temp_dir("resume-root");
        init_repo_with_commit(&base);

        let result = materialize_run_worktree_at(&root, &base, "resume-run-9999", true).await;
        assert!(result.is_err());

        cleanup_test_dirs(&[&root, &base]);
    }

    async fn snapshot_ref_exists(base: &Path, dir_name: &str) -> bool {
        git(
            base,
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("refs/xmatrix/snapshot/{dir_name}"),
            ],
            GIT_LOCAL_TIMEOUT,
        )
        .await
        .is_ok()
    }

    #[tokio::test]
    async fn gc_keeps_newest_skips_live_reclaims_oldest() {
        if !git_available() {
            return;
        }
        let base = unique_temp_dir("gc-base");
        let root = unique_temp_dir("gc-root");
        init_repo_with_commit(&base);

        let mut paths = Vec::new();
        for run in ["gc-run-aaaa", "gc-run-bbbb", "gc-run-cccc"] {
            let tree = materialize_run_worktree_at(&root, &base, run, false)
                .await
                .expect("materialize");
            paths.push(tree.path);
            std::thread::sleep(std::time::Duration::from_millis(60));
        }

        let live: std::collections::HashSet<PathBuf> = [paths[1].clone()].into_iter().collect();
        let outcome = gc_run_worktrees_at(&root, &live, true, 1).await;

        // Oldest non-live tree (aaaa) reclaimed; newest (cccc) kept; live
        // (bbbb) untouched. No remote in this repo, so history counts as
        // unpushed and the reclaim takes the snapshot path.
        assert_eq!(outcome.scanned, 3);
        assert_eq!(outcome.live, 1);
        assert_eq!(outcome.kept, 1);
        let oldest = run_worktree_dir_name("gc-run-aaaa").unwrap();
        assert_eq!(outcome.reclaimed, vec![oldest.clone()]);
        assert_eq!(outcome.snapshotted, vec![oldest.clone()]);
        assert!(outcome.skipped.is_empty(), "{:?}", outcome.skipped);
        assert!(!paths[0].exists());
        assert!(paths[1].exists());
        assert!(paths[2].exists());
        assert!(snapshot_ref_exists(&base, &oldest).await);

        cleanup_test_dirs(&[&root, &base]);
    }

    #[tokio::test]
    async fn gc_dry_run_reports_but_deletes_nothing() {
        if !git_available() {
            return;
        }
        let base = unique_temp_dir("gc-dry-base");
        let root = unique_temp_dir("gc-dry-root");
        init_repo_with_commit(&base);
        let tree = materialize_run_worktree_at(&root, &base, "gc-dry-run-1", false)
            .await
            .expect("materialize");

        let outcome = gc_run_worktrees_at(&root, &std::collections::HashSet::new(), false, 0).await;
        assert!(!outcome.apply);
        assert_eq!(outcome.reclaimed.len(), 1);
        assert!(tree.path.exists(), "dry-run must not delete");
        assert!(!snapshot_ref_exists(&base, &run_worktree_dir_name("gc-dry-run-1").unwrap()).await);

        cleanup_test_dirs(&[&root, &base]);
    }

    #[tokio::test]
    async fn gc_snapshots_dirty_worktree_before_reclaim() {
        if !git_available() {
            return;
        }
        let base = unique_temp_dir("gc-dirty-base");
        let root = unique_temp_dir("gc-dirty-root");
        init_repo_with_commit(&base);
        let tree = materialize_run_worktree_at(&root, &base, "gc-dirty-run-1", false)
            .await
            .expect("materialize");
        std::fs::write(tree.path.join("wip.txt"), "unsaved work").unwrap();

        let outcome = gc_run_worktrees_at(&root, &std::collections::HashSet::new(), true, 0).await;
        let dirty_dir = run_worktree_dir_name("gc-dirty-run-1").unwrap();
        assert_eq!(outcome.snapshotted, vec![dirty_dir.clone()]);
        assert!(!tree.path.exists());
        // The WIP file must be recoverable from the snapshot ref.
        let show_arg = format!("refs/xmatrix/snapshot/{dirty_dir}:wip.txt");
        let recovered = git(&base, &["show", &show_arg], GIT_LOCAL_TIMEOUT)
            .await
            .expect("snapshot must contain the dirty file");
        assert_eq!(recovered, "unsaved work");

        cleanup_test_dirs(&[&root, &base]);
    }

    #[tokio::test]
    async fn gc_honors_foreign_locks() {
        if !git_available() {
            return;
        }
        let base = unique_temp_dir("gc-lock-base");
        let root = unique_temp_dir("gc-lock-root");
        init_repo_with_commit(&base);
        let tree = materialize_run_worktree_at(&root, &base, "gc-lock-run-1", false)
            .await
            .expect("materialize");
        let path_arg = tree.path.display().to_string();
        git(&base, &["worktree", "unlock", &path_arg], GIT_LOCAL_TIMEOUT)
            .await
            .expect("unlock our lock");
        git(
            &base,
            &["worktree", "lock", "--reason", "manual-hold", &path_arg],
            GIT_LOCAL_TIMEOUT,
        )
        .await
        .expect("place foreign lock");

        let outcome = gc_run_worktrees_at(&root, &std::collections::HashSet::new(), true, 0).await;
        assert!(outcome.reclaimed.is_empty());
        assert_eq!(outcome.skipped.len(), 1);
        assert!(outcome.skipped[0].1.contains("manual-hold"));
        assert!(tree.path.exists());

        cleanup_test_dirs(&[&root, &base]);
    }

    #[tokio::test]
    async fn gc_reclaims_stale_named_linked_worktree_and_prunes_bindings() {
        if !git_available() {
            return;
        }
        let base = unique_temp_dir("gc-named-base");
        let root = unique_temp_dir("gc-named-root");
        init_repo_with_commit(&base);
        let named = root.join("channel-orphan-views");
        run_git(
            &base,
            &[
                "worktree",
                "add",
                "--detach",
                "--quiet",
                &named.display().to_string(),
                "HEAD",
            ],
        );
        let mut bindings = load_bindings(&root).expect("bindings");
        bindings.version = 1;
        bindings.bindings.insert(
            "run-deadbeefdead".to_string(),
            RunWorktreeBinding {
                path: root.join("run-deadbeefdead").display().to_string(),
                base_workspace: base.display().to_string(),
            },
        );
        save_bindings(&root, &bindings).expect("save bindings");

        let outcome = gc_run_worktrees_with_policy(
            &root,
            &std::collections::HashSet::new(),
            WorktreeGcPolicy {
                apply: true,
                keep: 12,
                named_min_age: Duration::ZERO,
            },
        )
        .await;
        assert!(
            outcome
                .reclaimed
                .iter()
                .any(|name| name == "channel-orphan-views"),
            "{:?}",
            outcome.reclaimed
        );
        assert!(!named.exists());
        assert_eq!(
            outcome.pruned_bindings,
            vec!["run-deadbeefdead".to_string()]
        );
        let remaining = load_bindings(&root).expect("bindings");
        assert!(
            remaining.bindings.is_empty(),
            "{:?}",
            remaining.bindings.keys()
        );

        cleanup_test_dirs(&[&root, &base]);
    }

    #[tokio::test]
    async fn gc_keeps_recent_named_linked_worktree() {
        if !git_available() {
            return;
        }
        let base = unique_temp_dir("gc-named-keep-base");
        let root = unique_temp_dir("gc-named-keep-root");
        init_repo_with_commit(&base);
        let named = root.join("release-recent");
        run_git(
            &base,
            &[
                "worktree",
                "add",
                "--detach",
                "--quiet",
                &named.display().to_string(),
                "HEAD",
            ],
        );

        let outcome = gc_run_worktrees_with_policy(
            &root,
            &std::collections::HashSet::new(),
            WorktreeGcPolicy {
                apply: true,
                keep: 12,
                named_min_age: Duration::from_secs(60 * 60),
            },
        )
        .await;
        assert!(outcome.reclaimed.is_empty(), "{:?}", outcome.reclaimed);
        assert!(named.exists());

        cleanup_test_dirs(&[&root, &base]);
    }

    #[tokio::test]
    async fn non_git_base_is_an_error() {
        if !git_available() {
            return;
        }
        let base = unique_temp_dir("plain");
        let root = unique_temp_dir("plain-root");

        let result = materialize_run_worktree_at(&root, &base, "plain-run-0001", false).await;
        assert!(result.is_err());

        cleanup_test_dirs(&[&root, &base]);
    }

    fn git_output(cwd: &Path, args: &[&str]) -> String {
        let output = git_command()
            .arg("-C")
            .arg(cwd)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?} failed in {}",
            cwd.display()
        );
        String::from_utf8(output.stdout).unwrap().trim().to_string()
    }

    /// A bare `origin` and a clone of it whose checkout is a stopped Run's.
    fn handoff_fixture(label: &str) -> (PathBuf, PathBuf) {
        let remote = unique_temp_dir(&format!("{label}-bare"));
        let checkout = unique_temp_dir(&format!("{label}-checkout"));
        run_git(
            &remote,
            &["init", "--bare", "--quiet", "--initial-branch=main"],
        );
        init_repo_with_commit(&checkout);
        std::fs::write(checkout.join(".gitignore"), "target/\n").unwrap();
        run_git(&checkout, &["add", ".gitignore"]);
        run_git(&checkout, &["commit", "--quiet", "-m", "ignore"]);
        let remote_arg = remote.display().to_string();
        run_git(&checkout, &["remote", "add", "origin", &remote_arg]);
        run_git(&checkout, &["push", "--quiet", "-u", "origin", "main"]);
        (remote, checkout)
    }

    #[test]
    fn handoff_branches_stay_in_their_namespace() {
        assert!(valid_handoff_branch("xmatrix/handoff/abc-123_x.y"));
        for branch in [
            "main",
            "xmatrix/handoff/",
            "xmatrix/handoff/a/b",
            "xmatrix/handoff/a..b",
            "xmatrix/handoff/a.lock",
            "xmatrix/handoff/a b",
            "refs/heads/xmatrix/handoff/a",
        ] {
            assert!(!valid_handoff_branch(branch), "{branch}");
        }
    }

    #[tokio::test]
    async fn handoff_carries_uncommitted_and_untracked_work_without_touching_the_checkout() {
        if !git_available() {
            return;
        }
        let (remote, checkout) = handoff_fixture("handoff-dirty");
        // An unpushed commit, a tracked edit, a staged new file, an untracked
        // file and an ignored build output.
        std::fs::write(checkout.join("committed.txt"), "local commit\n").unwrap();
        run_git(&checkout, &["add", "committed.txt"]);
        run_git(&checkout, &["commit", "--quiet", "-m", "unpushed"]);
        std::fs::write(checkout.join("README.md"), "edited\n").unwrap();
        std::fs::write(checkout.join("staged.txt"), "staged\n").unwrap();
        run_git(&checkout, &["add", "staged.txt"]);
        std::fs::write(checkout.join("untracked.txt"), "untracked\n").unwrap();
        std::fs::create_dir_all(checkout.join("target")).unwrap();
        std::fs::write(checkout.join("target/out.bin"), "ignored").unwrap();
        let status_before = git_output(&checkout, &["status", "--porcelain"]);
        let head_before = git_output(&checkout, &["rev-parse", "HEAD"]);

        let work = capture_handoff_work(&checkout, "@claude:3")
            .await
            .expect("capture");
        assert!(work.dirty);
        assert_eq!(work.base, head_before);
        assert_ne!(work.commit, work.base);
        push_handoff_work(&checkout, &work.commit, "xmatrix/handoff/t1")
            .await
            .expect("push");

        // The checkout, its index and its HEAD are exactly as the Run left them.
        assert_eq!(
            git_output(&checkout, &["status", "--porcelain"]),
            status_before
        );
        assert_eq!(git_output(&checkout, &["rev-parse", "HEAD"]), head_before);
        // The remote branch holds every piece of work and nothing ignored.
        let branch = "refs/heads/xmatrix/handoff/t1";
        assert_eq!(git_output(&remote, &["rev-parse", branch]), work.commit);
        for (path, body) in [
            ("README.md", "edited"),
            ("staged.txt", "staged"),
            ("untracked.txt", "untracked"),
            ("committed.txt", "local commit"),
        ] {
            assert_eq!(
                git_output(&remote, &["show", &format!("{branch}:{path}")]),
                body
            );
        }
        assert!(
            git_command()
                .arg("-C")
                .arg(&remote)
                .args(["cat-file", "-e", &format!("{branch}:target/out.bin")])
                .status()
                .map(|status| !status.success())
                .unwrap()
        );
        assert_eq!(
            git_output(&remote, &["log", "-1", "--format=%an <%ae>", branch]),
            "xMatrix <handoff@xmatrix.sh>"
        );
        assert_eq!(
            git_output(&remote, &["rev-parse", &format!("{branch}^")]),
            head_before
        );

        // A retried export of the same handoff moves its own branch.
        std::fs::write(checkout.join("untracked.txt"), "later\n").unwrap();
        let again = capture_handoff_work(&checkout, "@claude:3")
            .await
            .expect("capture again");
        push_handoff_work(&checkout, &again.commit, "xmatrix/handoff/t1")
            .await
            .expect("push again");
        assert_eq!(git_output(&remote, &["rev-parse", branch]), again.commit);
    }

    #[tokio::test]
    async fn a_clean_checkout_hands_off_its_head_and_a_foreign_branch_is_refused() {
        if !git_available() {
            return;
        }
        let (remote, checkout) = handoff_fixture("handoff-clean");
        std::fs::write(checkout.join("ahead.txt"), "ahead\n").unwrap();
        run_git(&checkout, &["add", "ahead.txt"]);
        run_git(&checkout, &["commit", "--quiet", "-m", "ahead"]);
        let head = git_output(&checkout, &["rev-parse", "HEAD"]);
        let work = capture_handoff_work(&checkout, "@codex:1")
            .await
            .expect("capture");
        assert_eq!(
            work,
            HandoffWork {
                base: head.clone(),
                commit: head.clone(),
                dirty: false
            }
        );
        push_handoff_work(&checkout, &work.commit, "xmatrix/handoff/t2")
            .await
            .expect("push");
        assert_eq!(
            git_output(&remote, &["rev-parse", "refs/heads/xmatrix/handoff/t2"]),
            head
        );
        assert!(
            push_handoff_work(&checkout, &work.commit, "main")
                .await
                .is_err()
        );
        assert_ne!(git_output(&remote, &["rev-parse", "refs/heads/main"]), head);
    }
}
