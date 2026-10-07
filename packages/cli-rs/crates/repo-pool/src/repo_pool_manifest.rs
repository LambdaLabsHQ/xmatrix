use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{File, OpenOptions};
use std::io::Read;
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::{Duration, Instant};
use xmatrix_cli_core::git_credential;

const MANIFEST_VERSION: u8 = 1;
const COMPACT_MANIFEST_VERSION: u8 = 2;
const MANIFEST_FILE: &str = "pool.json";
const SLOTS_DIR: &str = "slots";
const POOL_KEY_FILE: &str = "repo-key";
const POOL_DIR_KEY_CHARS: usize = 8;
const SLOT_DIR_CHARS: usize = 6;
const MAX_MANIFEST_BYTES: usize = 1_048_576;
const MAX_BINDINGS: usize = 512;
const MAX_SLOTS: usize = 512;
const MAX_ID_CHARS: usize = 256;
const MAX_SANITIZED_DETAIL: usize = 160;
const MAX_LOCK_REASON_BYTES: u64 = 1024;
const MAX_GITDIR_POINTER_BYTES: u64 = 4096;
/// Verifiable ownership tag; no secrets. Format:
/// `xmatrix-repo-pool:<repoKeyId>/<slotId>`
const WORKTREE_LOCK_REASON_PREFIX: &str = "xmatrix-repo-pool:";

const GIT_LOCAL_TIMEOUT: Duration = Duration::from_secs(20);
const GIT_FETCH_TIMEOUT: Duration = Duration::from_secs(120);
const GIT_FETCH_ATTEMPTS: u32 = 3;
/// Same-repo `:new` bursts share one snapshot. Long enough to cover a spawn
/// wave; short enough that a later lease is not hours behind origin.
const REQUIRED_FETCH_CACHE_TTL: Duration = Duration::from_secs(120);
const GIT_WORKTREE_ADD_TIMEOUT: Duration = Duration::from_secs(120);
const GIT_MUTATION_TIMEOUT: Duration = Duration::from_secs(120);

// Test-only failpoints (thread-local so parallel tests do not interfere).
// fail_on_tick: 1-based save count that should fail; 0 = disabled.
#[cfg(test)]
thread_local! {
    static TEST_FAIL_MANIFEST_SAVE_ON_TICK: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
    static TEST_MANIFEST_SAVE_TICK: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
    static TEST_FAIL_WORKTREE_UNLOCK: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static TEST_FAIL_WORKTREE_REMOVE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

// --- stable error codes (never raw git stderr with credentials) ---

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PoolErrorCode {
    InvalidIdentity,
    InvalidKey,
    InvalidSlotId,
    InvalidBinding,
    ManifestCorrupt,
    ManifestMismatch,
    PathEscape,
    RemoteMismatch,
    FetchRequiredFailed,
    BaseRefUnresolved,
    SnapshotCommitFailed,
    SnapshotRefFailed,
    ResetFailed,
    VerifyFailed,
    WorktreeCreateFailed,
    WorktreeMissing,
    ForeignWorktreeLock,
    WorktreeLockFailed,
    WorktreeCleanupFailed,
    IntermediateCrash,
    Io,
    Internal,
    DiskExhausted,
}

impl PoolErrorCode {
    fn as_str(self) -> &'static str {
        match self {
            Self::InvalidIdentity => "invalid_identity",
            Self::InvalidKey => "invalid_key",
            Self::InvalidSlotId => "invalid_slot_id",
            Self::InvalidBinding => "invalid_binding",
            Self::ManifestCorrupt => "manifest_corrupt",
            Self::ManifestMismatch => "manifest_mismatch",
            Self::PathEscape => "path_escape",
            Self::RemoteMismatch => "remote_mismatch",
            Self::FetchRequiredFailed => "fetch_required_failed",
            Self::BaseRefUnresolved => "base_ref_unresolved",
            Self::SnapshotCommitFailed => "snapshot_commit_failed",
            Self::SnapshotRefFailed => "snapshot_ref_failed",
            Self::ResetFailed => "reset_failed",
            Self::VerifyFailed => "verify_failed",
            Self::WorktreeCreateFailed => "worktree_create_failed",
            Self::WorktreeMissing => "worktree_missing",
            Self::ForeignWorktreeLock => "foreign_worktree_lock",
            Self::WorktreeLockFailed => "worktree_lock_failed",
            Self::WorktreeCleanupFailed => "worktree_cleanup_failed",
            Self::IntermediateCrash => "intermediate_crash",
            Self::Io => "io",
            Self::Internal => "internal",
            Self::DiskExhausted => "disk_exhausted",
        }
    }
}

#[derive(Debug, Clone)]
pub struct PoolError {
    pub code: PoolErrorCode,
    /// Safe, credential-free operator message (never raw remote URLs with userinfo).
    pub message: String,
}

impl PoolError {
    fn new(code: PoolErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: sanitize_detail(&message.into()),
        }
    }
}

impl std::fmt::Display for PoolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}

// --- newtypes ---

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct CanonicalRepoIdentity(String);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct RepoKeyId(String);

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SlotId(String);

impl CanonicalRepoIdentity {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl RepoKeyId {
    pub fn as_str(&self) -> &str {
        &self.0
    }

    fn parse_hex64(raw: &str) -> Result<Self, PoolError> {
        if raw.len() != 64 || !raw.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')) {
            return Err(PoolError::new(
                PoolErrorCode::InvalidKey,
                "repoKeyId must be 64 lowercase hex chars",
            ));
        }
        Ok(Self(raw.to_string()))
    }
}

impl SlotId {
    pub fn as_str(&self) -> &str {
        &self.0
    }

    fn parse(raw: &str) -> Result<Self, PoolError> {
        if raw.len() != 32 || !raw.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')) {
            return Err(PoolError::new(
                PoolErrorCode::InvalidSlotId,
                "slotId must be 32 lowercase hex chars",
            ));
        }
        Ok(Self(raw.to_string()))
    }

    fn generate() -> Self {
        Self(uuid::Uuid::new_v4().simple().to_string())
    }
}

// --- manifest ---

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum SlotState {
    Available,
    /// Durable spawn fence: the slot is bound, but the daemon has not yet
    /// completed pre-spawn admission. An exact retried command may rotate the
    /// token and safely start a replacement without permitting two writers.
    Starting,
    Leased,
    Retained,
    /// Crash window: create/lease materialization in progress.
    Preparing,
    /// Crash window: abandon return (reset/clean) in progress.
    Returning,
    Quarantined,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct SlotRecord {
    slot_id: String,
    state: SlotState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_base_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_base_oid: Option<String>,
    updated_at: String,
    /// Only set when state == Quarantined; stable enum, never raw git stderr.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    quarantine_code: Option<PoolErrorCode>,
    /// One-shot daemon pre-spawn claim. Present only while state == Starting;
    /// never part of repo identity, slot selection, or Hub-visible metadata.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    spawn_claim_token: Option<String>,
    /// Exact durable receipt for idempotent abandon completion after a daemon
    /// registry crash window. It is not a cache key or slot selector.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_returned_binding: Option<BindingRecord>,
}

impl SlotRecord {
    fn preparing(slot_id: &SlotId) -> Self {
        Self {
            slot_id: slot_id.as_str().to_string(),
            state: SlotState::Preparing,
            last_base_ref: None,
            last_base_oid: None,
            updated_at: now_rfc3339(),
            quarantine_code: None,
            spawn_claim_token: None,
            last_returned_binding: None,
        }
    }
}

/// Trusted absolute layout: ops never accept free-form pool_root strings.
#[derive(Debug, Clone)]
pub struct RepoPoolLayout {
    trusted_pools_root: PathBuf,
    repo_key: RepoKeyId,
    pool_root: PathBuf,
}

impl RepoPoolLayout {
    /// Create trusted root (if needed), canonicalize it, then create
    /// repo component with per-level reparse checks before any lock.
    pub fn create(trusted_pools_root: &Path, repo_key: RepoKeyId) -> Result<Self, PoolError> {
        if !trusted_pools_root.is_absolute() {
            return Err(PoolError::new(
                PoolErrorCode::PathEscape,
                "trusted pools root must be absolute",
            ));
        }
        reject_path_components(trusted_pools_root)?;
        std::fs::create_dir_all(trusted_pools_root)
            .map_err(|_| PoolError::new(PoolErrorCode::Io, "create trusted pools root failed"))?;
        set_dir_owner_private(trusted_pools_root)?;
        let trusted = {
            let canon = std::fs::canonicalize(trusted_pools_root).map_err(|_| {
                PoolError::new(
                    PoolErrorCode::PathEscape,
                    "canonicalize trusted pools root failed",
                )
            })?;
            strip_extended_length_prefix(canon)
        };
        // Preserve existing worktree paths, including retained/live slots.
        // Only the directory spelling is shortened; authority keeps the full key.
        let legacy = trusted.join(repo_key.as_str());
        let pool_root = match std::fs::symlink_metadata(&legacy) {
            Ok(_) => legacy,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                trusted.join(&repo_key.as_str()[..POOL_DIR_KEY_CHARS])
            }
            Err(_) => {
                return Err(PoolError::new(
                    PoolErrorCode::Io,
                    "inspect legacy pool failed",
                ));
            }
        };
        create_component_dir_checked(&trusted, &pool_root)?;
        if pool_root.file_name().and_then(|name| name.to_str()) != Some(repo_key.as_str()) {
            claim_compact_pool(&pool_root, &repo_key)?;
        }
        if pool_root.file_name().and_then(|name| name.to_str()) == Some(repo_key.as_str()) {
            create_component_dir_checked(&trusted, &pool_root.join(SLOTS_DIR))?;
        }
        Ok(Self {
            trusted_pools_root: trusted,
            repo_key,
            pool_root,
        })
    }

    pub fn from_persisted(trusted_pools_root: &Path, repo_key_id: &str) -> Result<Self, PoolError> {
        Self::create(trusted_pools_root, RepoKeyId::parse_hex64(repo_key_id)?)
    }

    pub(crate) fn pool_root(&self) -> &Path {
        &self.pool_root
    }

    fn trusted_pools_root(&self) -> &Path {
        &self.trusted_pools_root
    }

    fn repo_key(&self) -> &RepoKeyId {
        &self.repo_key
    }

    fn slot_path_for_id(&self, slot_id: &str) -> Result<PathBuf, PoolError> {
        self.slot_path(&SlotId::parse(slot_id)?)
    }

    fn slot_path(&self, slot_id: &SlotId) -> Result<PathBuf, PoolError> {
        let path = self.slots_root().join(self.slot_component(slot_id));
        ensure_path_inside_layout(self, &path)?;
        Ok(path)
    }

    fn is_compact(&self) -> bool {
        self.pool_root.file_name().and_then(|name| name.to_str()) != Some(self.repo_key.as_str())
    }

    fn manifest_version(&self) -> u8 {
        if self.is_compact() {
            COMPACT_MANIFEST_VERSION
        } else {
            MANIFEST_VERSION
        }
    }

    fn slots_root(&self) -> PathBuf {
        if self.is_compact() {
            self.pool_root.clone()
        } else {
            self.pool_root.join(SLOTS_DIR)
        }
    }

    fn slot_component<'a>(&self, slot_id: &'a SlotId) -> &'a str {
        if self.is_compact() {
            &slot_id.as_str()[..SLOT_DIR_CHARS]
        } else {
            slot_id.as_str()
        }
    }

    /// Re-validate repo/slots on disk before a coordinated mutation.
    /// Detects post-create junction/symlink replacement of any component.
    fn revalidate_on_disk(&self) -> Result<(), PoolError> {
        let trusted = &self.trusted_pools_root;
        if !trusted.is_absolute() || !trusted.exists() {
            return Err(PoolError::new(
                PoolErrorCode::PathEscape,
                "trusted pools root missing or not absolute",
            ));
        }
        let trusted_c =
            strip_extended_length_prefix(std::fs::canonicalize(trusted).map_err(|_| {
                PoolError::new(
                    PoolErrorCode::PathEscape,
                    "canonicalize trusted root failed",
                )
            })?);
        // Accept only the two deterministic directory encodings of this key.
        let name = self.pool_root.file_name().and_then(|name| name.to_str());
        if name != Some(self.repo_key.as_str())
            && name != Some(&self.repo_key.as_str()[..POOL_DIR_KEY_CHARS])
        {
            return Err(PoolError::new(
                PoolErrorCode::PathEscape,
                "invalid pool directory",
            ));
        }
        let repo_dir = trusted_c.join(name.unwrap());
        let slots_dir = if self.is_compact() {
            repo_dir.clone()
        } else {
            repo_dir.join(SLOTS_DIR)
        };
        for dir in [&repo_dir, &slots_dir] {
            // Use symlink_metadata (lstat) so junctions are visible before follow.
            let meta = std::fs::symlink_metadata(dir).map_err(|_| {
                PoolError::new(
                    PoolErrorCode::PathEscape,
                    "pool component missing on revalidate",
                )
            })?;
            reject_reparse(dir)?;
            if !meta.is_dir() {
                return Err(PoolError::new(
                    PoolErrorCode::PathEscape,
                    "pool component is not a directory",
                ));
            }
            let dir_c = strip_extended_length_prefix(std::fs::canonicalize(dir).map_err(|_| {
                PoolError::new(
                    PoolErrorCode::PathEscape,
                    "canonicalize pool component failed",
                )
            })?);
            if !path_is_within(&trusted_c, &dir_c) && dir_c != trusted_c {
                return Err(PoolError::new(
                    PoolErrorCode::PathEscape,
                    "pool component escaped trusted root",
                ));
            }
        }
        // Recorded pool_root must canonicalize to the expected repo component.
        let expected_pool =
            strip_extended_length_prefix(std::fs::canonicalize(&repo_dir).map_err(|_| {
                PoolError::new(PoolErrorCode::PathEscape, "canonicalize pool_root failed")
            })?);
        let recorded_c =
            strip_extended_length_prefix(std::fs::canonicalize(&self.pool_root).map_err(|_| {
                PoolError::new(
                    PoolErrorCode::PathEscape,
                    "canonicalize recorded pool_root failed",
                )
            })?);
        if recorded_c != expected_pool {
            return Err(PoolError::new(
                PoolErrorCode::PathEscape,
                "pool_root no longer matches layout identity",
            ));
        }
        if name != Some(self.repo_key.as_str()) {
            validate_compact_pool_key(&repo_dir, &self.repo_key)?;
        }
        Ok(())
    }
}

// Claim before creating slots or loading a manifest. create_new prevents two
// full keys sharing a short prefix from ever adopting the same empty pool.
// A partial claim after a crash fails closed, even when no manifest exists yet.
fn claim_compact_pool(pool_root: &Path, key: &RepoKeyId) -> Result<(), PoolError> {
    // Layout construction precedes the async mutation coordinator. Serialize
    // this short initialization step so same-daemon readers see a complete claim.
    static CLAIM_GUARD: StdMutex<()> = StdMutex::new(());
    let _guard = CLAIM_GUARD
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let path = pool_root.join(POOL_KEY_FILE);
    match OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(mut file) => {
            file.write_all(key.as_str().as_bytes())
                .and_then(|_| file.sync_all())
                .map_err(|_| PoolError::new(PoolErrorCode::Io, "write compact pool key failed"))?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => {
            return Err(PoolError::new(
                PoolErrorCode::Io,
                "claim compact pool failed",
            ));
        }
    }
    validate_compact_pool_key(pool_root, key)
}

fn validate_compact_pool_key(pool_root: &Path, key: &RepoKeyId) -> Result<(), PoolError> {
    if read_compact_pool_key(pool_root)? != *key {
        return Err(PoolError::new(
            PoolErrorCode::ManifestMismatch,
            "compact pool key collision",
        ));
    }
    Ok(())
}

fn read_compact_pool_key(pool_root: &Path) -> Result<RepoKeyId, PoolError> {
    reject_reparse(pool_root)?;
    let path = pool_root.join(POOL_KEY_FILE);
    reject_reparse(&path)?;
    let metadata = std::fs::symlink_metadata(&path)
        .map_err(|_| PoolError::new(PoolErrorCode::ManifestMismatch, "compact pool key missing"))?;
    if !metadata.is_file() || metadata.len() != 64 {
        return Err(PoolError::new(
            PoolErrorCode::ManifestMismatch,
            "invalid compact pool key",
        ));
    }
    let mut bytes = Vec::new();
    File::open(&path)
        .and_then(|file| file.take(65).read_to_end(&mut bytes))
        .map_err(|_| PoolError::new(PoolErrorCode::Io, "read compact pool key failed"))?;
    RepoKeyId::parse_hex64(std::str::from_utf8(&bytes).unwrap_or_default())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct BindingRecord {
    session_key: String,
    instance_id: String,
    run_id: String,
    execution_key: String,
    slot_id: String,
}

impl BindingRecord {
    fn authority(&self) -> BindingAuthority {
        BindingAuthority::new(
            &self.session_key,
            &self.instance_id,
            &self.run_id,
            &self.execution_key,
            &self.slot_id,
        )
    }

    fn for_lease(slot_id: &SlotId, request: &LeaseRequest) -> Self {
        Self {
            session_key: request.session_key.clone(),
            instance_id: request.instance_id.clone(),
            run_id: request.run_id.clone(),
            execution_key: request.execution_key.clone(),
            slot_id: slot_id.as_str().to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct RepoPoolManifest {
    version: u8,
    canonical_repo_identity: String,
    repo_key_id: String,
    /// Durable pool parent checkout. Recorded on first lease. Later registered
    /// workspace checkouts of the same remote must not replace it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    base_repo_path: Option<String>,
    slots: BTreeMap<String, SlotRecord>,
    bindings: Vec<BindingRecord>,
}

/// Exact binding authority for rebind expected side (includes slotId).
#[derive(Debug, Clone)]
pub struct BindingAuthority {
    pub session_key: String,
    pub instance_id: String,
    pub run_id: String,
    pub execution_key: String,
    pub slot_id: String,
}

impl BindingAuthority {
    pub fn new(
        session_key: &str,
        instance_id: &str,
        run_id: &str,
        execution_key: &str,
        slot_id: &str,
    ) -> Self {
        Self {
            session_key: session_key.to_string(),
            instance_id: instance_id.to_string(),
            run_id: run_id.to_string(),
            execution_key: execution_key.to_string(),
            slot_id: slot_id.to_string(),
        }
    }
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct LeaseRequest {
    pub session_key: String,
    pub instance_id: String,
    pub run_id: String,
    pub execution_key: String,
}

impl LeaseRequest {
    fn from_authority(authority: &BindingAuthority) -> Self {
        Self {
            session_key: authority.session_key.clone(),
            instance_id: authority.instance_id.clone(),
            run_id: authority.run_id.clone(),
            execution_key: authority.execution_key.clone(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct LeaseResult {
    pub slot_id: SlotId,
    pub worktree_path: PathBuf,
    pub base_ref: String,
    pub reused_available: bool,
    pub spawn_claim_token: String,
}

#[derive(Debug, Clone)]
pub struct RetainedLease {
    pub authority: BindingAuthority,
    pub canonical_repo_identity: String,
}

pub fn default_repo_pools_root() -> Result<PathBuf, PoolError> {
    let config_root = xmatrix_cli_core::config::profile_state_dir();
    if !config_root.is_absolute() {
        return Err(PoolError::new(
            PoolErrorCode::PathEscape,
            "repo pool requires an absolute local config root",
        ));
    }
    Ok(config_root.join("repo-pools"))
}

// --- identity ---

pub fn canonical_repo_identity(input: &str) -> Result<CanonicalRepoIdentity, PoolError> {
    let trimmed = input.trim();
    if trimmed.is_empty() || trimmed.contains(char::is_whitespace) {
        return Err(PoolError::new(
            PoolErrorCode::InvalidIdentity,
            "empty or whitespace repo reference",
        ));
    }
    if looks_like_local_path(trimmed) {
        return Err(PoolError::new(
            PoolErrorCode::InvalidIdentity,
            "local path is not a remote repo identity",
        ));
    }
    if let Some(identity) = parse_http_identity(trimmed)? {
        return Ok(CanonicalRepoIdentity(identity));
    }
    if let Some(identity) = parse_ssh_url_identity(trimmed)? {
        return Ok(CanonicalRepoIdentity(identity));
    }
    // Parse canonical host/path spellings before scp-like syntax. A colon in
    // an unqualified Git remote remains scp's path separator; explicit ports
    // are canonicalized with a scheme and handled above.
    if let Some(identity) = parse_host_path_identity(trimmed) {
        return Ok(CanonicalRepoIdentity(identity));
    }
    if let Some(identity) = parse_scp_identity(trimmed)? {
        return Ok(CanonicalRepoIdentity(identity));
    }
    if is_owner_repo(trimmed) {
        return Ok(CanonicalRepoIdentity(exact_github_owner_repo(
            strip_optional_dot_git(trimmed),
        )?));
    }
    Err(PoolError::new(
        PoolErrorCode::InvalidIdentity,
        "unrecognized repo reference",
    ))
}

pub fn repo_key_id(identity: &CanonicalRepoIdentity) -> RepoKeyId {
    RepoKeyId(hex_sha256(identity.as_str().as_bytes()))
}

/// Create one directory component under trusted root with reparse checks.
fn create_component_dir_checked(trusted: &Path, dir: &Path) -> Result<(), PoolError> {
    if dir.exists() {
        reject_reparse(dir)?;
        // Must be a real directory, not a junction/symlink already rejected above.
        let meta = std::fs::symlink_metadata(dir).map_err(|_| {
            PoolError::new(
                PoolErrorCode::PathEscape,
                "metadata failed for pool component",
            )
        })?;
        if !meta.is_dir() {
            return Err(PoolError::new(
                PoolErrorCode::PathEscape,
                "pool component is not a directory",
            ));
        }
        set_dir_owner_private(dir)?;
    } else {
        // Parent must already exist (created level-by-level); do not bare create_dir_all.
        create_dir_owner_private(dir)?;
        reject_reparse(dir)?;
    }
    // Ensure the created path still sits under trusted after resolve.
    let trusted_c = std::fs::canonicalize(trusted)
        .map_err(|_| PoolError::new(PoolErrorCode::PathEscape, "canonicalize trusted failed"))?;
    let trusted_c = strip_extended_length_prefix(trusted_c);
    let dir_c = std::fs::canonicalize(dir)
        .map_err(|_| PoolError::new(PoolErrorCode::PathEscape, "canonicalize component failed"))?;
    let dir_c = strip_extended_length_prefix(dir_c);
    if !path_is_within(&trusted_c, &dir_c) && dir_c != trusted_c {
        return Err(PoolError::new(
            PoolErrorCode::PathEscape,
            "pool component escaped trusted root",
        ));
    }
    Ok(())
}

// --- load / save / validate ---

fn load_manifest_at(pool_root: &Path) -> Result<Option<RepoPoolManifest>, PoolError> {
    let path = pool_root.join(MANIFEST_FILE);
    match std::fs::symlink_metadata(&path) {
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => {
            return Err(PoolError::new(
                PoolErrorCode::Io,
                "cannot stat pool manifest",
            ));
        }
        Ok(meta) => {
            // No-follow: refuse symlink/reparse control files.
            ensure_regular_file_no_reparse(&path, &meta)?;
            if meta.len() > MAX_MANIFEST_BYTES as u64 {
                return Err(PoolError::new(
                    PoolErrorCode::ManifestCorrupt,
                    "manifest exceeds size limit",
                ));
            }
        }
    }
    // Bounded read: never load more than MAX_MANIFEST_BYTES + 1.
    let file = open_existing_control_file(&path)?;
    let mut raw = Vec::new();
    file.take(MAX_MANIFEST_BYTES as u64 + 1)
        .read_to_end(&mut raw)
        .map_err(|_| PoolError::new(PoolErrorCode::Io, "cannot read pool manifest"))?;
    if raw.len() > MAX_MANIFEST_BYTES {
        return Err(PoolError::new(
            PoolErrorCode::ManifestCorrupt,
            "manifest exceeds size limit",
        ));
    }
    let manifest: RepoPoolManifest = serde_json::from_slice(&raw)
        .map_err(|_| PoolError::new(PoolErrorCode::ManifestCorrupt, "manifest json invalid"))?;
    validate_manifest(&manifest)?;
    Ok(Some(manifest))
}

fn write_private_pool_record(
    temp_path: &Path,
    final_path: &Path,
    bytes: &[u8],
    kind: &'static str,
) -> Result<(), PoolError> {
    {
        let mut file = open_file_owner_private(temp_path, true)?;
        file.write_all(bytes)
            .map_err(|_| PoolError::new(PoolErrorCode::Io, format!("write {kind} temp failed")))?;
        file.sync_all()
            .map_err(|_| PoolError::new(PoolErrorCode::Io, format!("sync {kind} temp failed")))?;
        // Re-assert mode after write, before publishing the private record.
        set_file_owner_private(temp_path)?;
    }
    if xmatrix_cli_core::config::replace_file_atomically(temp_path, final_path).is_err() {
        let _ = std::fs::remove_file(temp_path);
        return Err(PoolError::new(
            PoolErrorCode::Io,
            format!("atomic replace {kind} failed"),
        ));
    }
    set_file_owner_private(final_path)
}

fn save_manifest_at(pool_root: &Path, manifest: &RepoPoolManifest) -> Result<(), PoolError> {
    validate_manifest(manifest)?;
    #[cfg(test)]
    {
        let tick = TEST_MANIFEST_SAVE_TICK.with(|c| {
            let next = c.get() + 1;
            c.set(next);
            next
        });
        let fail_on = TEST_FAIL_MANIFEST_SAVE_ON_TICK.with(|c| c.get());
        if fail_on > 0 && tick == fail_on {
            return Err(PoolError::new(
                PoolErrorCode::Io,
                "injected manifest save failure",
            ));
        }
    }
    if !pool_root.is_dir() {
        return Err(PoolError::new(
            PoolErrorCode::PathEscape,
            "pool root missing at manifest save",
        ));
    }
    set_dir_owner_private(pool_root)?;
    let final_path = pool_root.join(MANIFEST_FILE);
    // Destination must not be a symlink/reparse (would replace or chmod outside).
    if let Ok(meta) = std::fs::symlink_metadata(&final_path) {
        ensure_regular_file_no_reparse(&final_path, &meta)?;
    }
    let temp_path = xmatrix_cli_core::config::unique_temporary_path(&final_path);
    let json = serde_json::to_vec_pretty(manifest)
        .map_err(|_| PoolError::new(PoolErrorCode::Internal, "serialize manifest failed"))?;
    if json.len() > MAX_MANIFEST_BYTES {
        return Err(PoolError::new(
            PoolErrorCode::ManifestCorrupt,
            "manifest would exceed size limit",
        ));
    }
    write_private_pool_record(&temp_path, &final_path, &json, "manifest")
}

fn validate_manifest(manifest: &RepoPoolManifest) -> Result<(), PoolError> {
    if !matches!(
        manifest.version,
        MANIFEST_VERSION | COMPACT_MANIFEST_VERSION
    ) {
        return Err(PoolError::new(
            PoolErrorCode::ManifestCorrupt,
            "unsupported manifest version",
        ));
    }
    if manifest.slots.len() > MAX_SLOTS || manifest.bindings.len() > MAX_BINDINGS {
        return Err(PoolError::new(
            PoolErrorCode::ManifestCorrupt,
            "too many slots or bindings",
        ));
    }

    // Re-canonicalize identity and recompute key (no uppercase accept).
    let identity = canonical_repo_identity(&manifest.canonical_repo_identity)?;
    if identity.as_str() != manifest.canonical_repo_identity {
        return Err(PoolError::new(
            PoolErrorCode::ManifestMismatch,
            "canonicalRepoIdentity is not in canonical form",
        ));
    }
    let expected_key = repo_key_id(&identity);
    let stored_key = RepoKeyId::parse_hex64(&manifest.repo_key_id)?;
    if stored_key.as_str() != expected_key.as_str() {
        return Err(PoolError::new(
            PoolErrorCode::ManifestMismatch,
            "repoKeyId does not match sha256(canonicalRepoIdentity)",
        ));
    }
    if let Some(base_repo_path) = manifest.base_repo_path.as_deref() {
        let path = Path::new(base_repo_path);
        if !path.is_absolute() || base_repo_path.chars().any(|c| c.is_control() || c == '\0') {
            return Err(PoolError::new(
                PoolErrorCode::ManifestCorrupt,
                "baseRepoPath must be an absolute path",
            ));
        }
        reject_path_components(path)?;
    }
    let mut seen_slots = BTreeSet::new();
    let mut seen_slot_paths = BTreeSet::new();
    for (id, slot) in &manifest.slots {
        let slot_id = SlotId::parse(&slot.slot_id)?;
        if id != slot_id.as_str() {
            return Err(PoolError::new(
                PoolErrorCode::ManifestCorrupt,
                "slot map key must equal slotId",
            ));
        }
        if manifest.version == COMPACT_MANIFEST_VERSION
            && !seen_slot_paths.insert(&slot.slot_id[..SLOT_DIR_CHARS])
        {
            return Err(PoolError::new(
                PoolErrorCode::ManifestCorrupt,
                "duplicate compact slot path",
            ));
        }
        if !seen_slots.insert(slot.slot_id.clone()) {
            return Err(PoolError::new(
                PoolErrorCode::ManifestCorrupt,
                "duplicate slotId",
            ));
        }
    }

    let mut seen_sessions = BTreeSet::new();
    let mut seen_instances = BTreeSet::new();
    let mut seen_runs = BTreeSet::new();
    let mut seen_execs = BTreeSet::new();
    let mut bound_slots = BTreeSet::new();
    for binding in &manifest.bindings {
        validate_binding_field("sessionKey", &binding.session_key)?;
        validate_binding_field("instanceId", &binding.instance_id)?;
        validate_binding_field("runId", &binding.run_id)?;
        validate_binding_field("executionKey", &binding.execution_key)?;
        let slot_id = SlotId::parse(&binding.slot_id)?;
        if !seen_sessions.insert(binding.session_key.clone())
            || !seen_instances.insert(binding.instance_id.clone())
            || !seen_runs.insert(binding.run_id.clone())
            || !seen_execs.insert(binding.execution_key.clone())
            || !bound_slots.insert(slot_id.as_str().to_string())
        {
            return Err(PoolError::new(
                PoolErrorCode::InvalidBinding,
                "binding fields must be unique across session/instance/run/execution/slot",
            ));
        }
        let slot = manifest.slots.get(slot_id.as_str()).ok_or_else(|| {
            PoolError::new(
                PoolErrorCode::InvalidBinding,
                "binding references missing slot",
            )
        })?;
        // Starting, Leased, Retained, Returning, Preparing, Quarantined may carry binding.
        // Available must not.
        if matches!(slot.state, SlotState::Available) {
            return Err(PoolError::new(
                PoolErrorCode::InvalidBinding,
                "available slot must not have a binding",
            ));
        }
    }

    for (id, slot) in &manifest.slots {
        validate_updated_at(&slot.updated_at)?;
        if let Some(receipt) = slot.last_returned_binding.as_ref() {
            validate_binding_field("lastReturned.sessionKey", &receipt.session_key)?;
            validate_binding_field("lastReturned.instanceId", &receipt.instance_id)?;
            validate_binding_field("lastReturned.runId", &receipt.run_id)?;
            validate_binding_field("lastReturned.executionKey", &receipt.execution_key)?;
            let receipt_slot = SlotId::parse(&receipt.slot_id)?;
            if receipt_slot.as_str() != id || receipt_slot.as_str() != slot.slot_id {
                return Err(PoolError::new(
                    PoolErrorCode::InvalidBinding,
                    "last returned binding references a different slot",
                ));
            }
        }
        match slot.state {
            SlotState::Available => {
                if bound_slots.contains(id) {
                    return Err(PoolError::new(
                        PoolErrorCode::InvalidBinding,
                        "available slot has binding",
                    ));
                }
                require_base_pair(slot)?;
                if slot.quarantine_code.is_some() {
                    return Err(PoolError::new(
                        PoolErrorCode::ManifestCorrupt,
                        "non-quarantined slot has quarantine_code",
                    ));
                }
                require_no_spawn_claim(slot)?;
            }
            SlotState::Starting => {
                if !bound_slots.contains(id) {
                    return Err(PoolError::new(
                        PoolErrorCode::InvalidBinding,
                        "starting slot requires binding",
                    ));
                }
                require_base_pair(slot)?;
                if slot.quarantine_code.is_some() {
                    return Err(PoolError::new(
                        PoolErrorCode::ManifestCorrupt,
                        "starting slot must not have quarantine_code",
                    ));
                }
                validate_spawn_claim_token(slot.spawn_claim_token.as_deref().ok_or_else(
                    || {
                        PoolError::new(
                            PoolErrorCode::ManifestCorrupt,
                            "starting slot requires spawnClaimToken",
                        )
                    },
                )?)?;
            }
            SlotState::Leased | SlotState::Retained => {
                if !bound_slots.contains(id) {
                    return Err(PoolError::new(
                        PoolErrorCode::InvalidBinding,
                        "leased/retained slot requires binding",
                    ));
                }
                require_base_pair(slot)?;
                if slot.quarantine_code.is_some() {
                    return Err(PoolError::new(
                        PoolErrorCode::ManifestCorrupt,
                        "non-quarantined slot has quarantine_code",
                    ));
                }
                require_no_spawn_claim(slot)?;
            }
            SlotState::Returning => {
                if !bound_slots.contains(id) {
                    return Err(PoolError::new(
                        PoolErrorCode::InvalidBinding,
                        "returning slot requires binding",
                    ));
                }
                if slot.quarantine_code.is_some() {
                    return Err(PoolError::new(
                        PoolErrorCode::ManifestCorrupt,
                        "returning slot must not have quarantine_code",
                    ));
                }
                // Either both absent or both valid — no half pairs.
                require_base_pair_or_none(slot)?;
                require_no_spawn_claim(slot)?;
            }
            SlotState::Preparing => {
                if slot.quarantine_code.is_some() {
                    return Err(PoolError::new(
                        PoolErrorCode::ManifestCorrupt,
                        "preparing slot must not have quarantine_code",
                    ));
                }
                require_base_pair_or_none(slot)?;
                require_no_spawn_claim(slot)?;
            }
            SlotState::Quarantined => {
                if slot.quarantine_code.is_none() {
                    return Err(PoolError::new(
                        PoolErrorCode::ManifestCorrupt,
                        "quarantined slot requires quarantine_code",
                    ));
                }
                require_base_pair_or_none(slot)?;
                require_no_spawn_claim(slot)?;
            }
        }
    }
    Ok(())
}

/// Read only the exact durable local authority already bound to a command.
/// Used on command replay so even a pre-spawn-admitted Run whose registry
/// sidecar is not yet recoverable can return typed abandon metadata instead of
/// losing the slot route. This never treats a partial/session-only match as authority.
pub async fn exact_bound_slot_for_request_at(
    layout: &RepoPoolLayout,
    request: &LeaseRequest,
) -> Result<Option<SlotId>, PoolError> {
    validate_request(request)?;
    let _guard = acquire_pool_guard(layout).await?;
    let Some(manifest) = load_for_update(layout)? else {
        return Ok(None);
    };
    let Some(binding) = manifest.bindings.iter().find(|binding| {
        binding.session_key == request.session_key
            && binding.instance_id == request.instance_id
            && binding.run_id == request.run_id
            && binding.execution_key == request.execution_key
    }) else {
        return Ok(None);
    };
    let slot_id = SlotId::parse(&binding.slot_id)?;
    let slot = manifest
        .slots
        .get(slot_id.as_str())
        .ok_or_else(|| PoolError::new(PoolErrorCode::InvalidSlotId, "binding slot missing"))?;
    if matches!(slot.state, SlotState::Available) {
        return Err(PoolError::new(
            PoolErrorCode::InvalidBinding,
            "bound slot cannot be Available",
        ));
    }
    Ok(Some(slot_id))
}

fn validate_spawn_claim_token(token: &str) -> Result<(), PoolError> {
    if token.len() != 32 || !token.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')) {
        return Err(PoolError::new(
            PoolErrorCode::ManifestCorrupt,
            "spawnClaimToken must be 32 lowercase hex chars",
        ));
    }
    Ok(())
}

fn require_no_spawn_claim(slot: &SlotRecord) -> Result<(), PoolError> {
    if slot.spawn_claim_token.is_some() {
        return Err(PoolError::new(
            PoolErrorCode::ManifestCorrupt,
            "spawnClaimToken is only valid for Starting",
        ));
    }
    Ok(())
}

fn fresh_spawn_claim_token() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

fn require_base_pair(slot: &SlotRecord) -> Result<(), PoolError> {
    match (&slot.last_base_ref, &slot.last_base_oid) {
        (Some(r), Some(o)) => {
            validate_base_ref(r)?;
            validate_oid(o)?;
            Ok(())
        }
        _ => Err(PoolError::new(
            PoolErrorCode::ManifestCorrupt,
            "fresh complete state requires lastBaseRef+lastBaseOid pair",
        )),
    }
}

fn require_base_pair_or_none(slot: &SlotRecord) -> Result<(), PoolError> {
    match (&slot.last_base_ref, &slot.last_base_oid) {
        (None, None) => Ok(()),
        (Some(r), Some(o)) => {
            validate_base_ref(r)?;
            validate_oid(o)?;
            Ok(())
        }
        _ => Err(PoolError::new(
            PoolErrorCode::ManifestCorrupt,
            "base ref/oid must both be present or both absent",
        )),
    }
}

fn validate_oid(oid: &str) -> Result<(), PoolError> {
    let ok = (oid.len() == 40 || oid.len() == 64)
        && oid.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f'));
    if !ok {
        return Err(PoolError::new(
            PoolErrorCode::ManifestCorrupt,
            "lastBaseOid must be 40 or 64 lowercase hex",
        ));
    }
    Ok(())
}

fn validate_base_ref(r: &str) -> Result<(), PoolError> {
    if r.is_empty() || r.len() > MAX_ID_CHARS {
        return Err(PoolError::new(
            PoolErrorCode::ManifestCorrupt,
            "lastBaseRef length invalid",
        ));
    }
    if r.chars()
        .any(|c| c.is_control() || c == '\0' || c.is_whitespace())
    {
        return Err(PoolError::new(
            PoolErrorCode::ManifestCorrupt,
            "lastBaseRef contains control/whitespace",
        ));
    }
    if r.starts_with('-') {
        return Err(PoolError::new(
            PoolErrorCode::ManifestCorrupt,
            "lastBaseRef must not start with -",
        ));
    }
    // Accept the remote-tracking form surfaced in spawn environment and metadata.
    if !r.starts_with("origin/") {
        return Err(PoolError::new(
            PoolErrorCode::ManifestCorrupt,
            "lastBaseRef must be origin/<name>",
        ));
    }
    let rest = &r["origin/".len()..];
    if rest.is_empty() || rest.contains("..") {
        return Err(PoolError::new(
            PoolErrorCode::ManifestCorrupt,
            "lastBaseRef remote branch name invalid",
        ));
    }
    Ok(())
}

fn validate_updated_at(s: &str) -> Result<(), PoolError> {
    // Strict enough: RFC3339 parse via time crate.
    time::OffsetDateTime::parse(s, &time::format_description::well_known::Rfc3339)
        .map_err(|_| PoolError::new(PoolErrorCode::ManifestCorrupt, "updatedAt must be RFC3339"))?;
    Ok(())
}

fn validate_manifest_matches_layout(
    manifest: &RepoPoolManifest,
    layout: &RepoPoolLayout,
) -> Result<(), PoolError> {
    if manifest.version != layout.manifest_version() {
        return Err(PoolError::new(
            PoolErrorCode::ManifestMismatch,
            "manifest version does not match pool layout",
        ));
    }
    if manifest.repo_key_id != layout.repo_key().as_str() {
        return Err(PoolError::new(
            PoolErrorCode::ManifestMismatch,
            "pool manifest does not match its repo layout",
        ));
    }
    Ok(())
}

/// Load manifest, bind it to the repo directory, then reconcile crash
/// intermediates. A swapped manifest must fail before this function mutates or
/// persists any of its authority state.
fn load_for_update(layout: &RepoPoolLayout) -> Result<Option<RepoPoolManifest>, PoolError> {
    let mut manifest = load_manifest_at(layout.pool_root())?;
    if let Some(ref mut m) = manifest {
        validate_manifest_matches_layout(m, layout)?;
        if reconcile_intermediate_states(layout.pool_root(), m) {
            save_manifest_at(layout.pool_root(), m)?;
        }
    }
    Ok(manifest)
}

/// Returns true if any slot was rewritten. A spare this daemon is still
/// building outside the pool lock is Preparing on purpose, not a crash.
fn reconcile_intermediate_states(pool_root: &Path, manifest: &mut RepoPoolManifest) -> bool {
    let mut changed = false;
    for (id, slot) in manifest.slots.iter_mut() {
        if matches!(slot.state, SlotState::Preparing | SlotState::Returning)
            && !spare_is_warming(pool_root, id)
        {
            slot.state = SlotState::Quarantined;
            slot.quarantine_code = Some(PoolErrorCode::IntermediateCrash);
            slot.spawn_claim_token = None;
            slot.updated_at = now_rfc3339();
            changed = true;
        }
    }
    changed
}

fn validate_binding_field(name: &str, value: &str) -> Result<(), PoolError> {
    if value.is_empty() || value.len() > MAX_ID_CHARS {
        return Err(PoolError::new(
            PoolErrorCode::InvalidBinding,
            format!("{name} length invalid"),
        ));
    }
    if value.chars().any(|c| c.is_control() || c == '\0') {
        return Err(PoolError::new(
            PoolErrorCode::InvalidBinding,
            format!("{name} contains control characters"),
        ));
    }
    Ok(())
}

// --- crate-private product operations ---

pub async fn lease_available_or_create_at(
    layout: &RepoPoolLayout,
    base_repo: &Path,
    canonical_repo: &str,
    request: &LeaseRequest,
) -> Result<LeaseResult, PoolError> {
    validate_request(request)?;
    let identity = canonical_repo_identity(canonical_repo)?;
    if repo_key_id(&identity).as_str() != layout.repo_key().as_str() {
        return Err(PoolError::new(
            PoolErrorCode::ManifestMismatch,
            "layout repo key does not match identity",
        ));
    }
    // Fetch is repo infrastructure, not a lease mutation. Do it before the
    // pool lock so a 120s origin round-trip cannot stall retain/reborn/return
    // on the same repository. Same-base callers single-flight and reuse.
    // Prefer the pinned parent: a later workspace checkout of the same remote
    // has its own object store and must not supply the oid we detach onto.
    let fetch_repo = fetch_repo_for_pool(layout, base_repo);
    let fetched = required_fetch_and_resolve(&fetch_repo).await?;
    let _guard = acquire_pool_guard(layout).await?;
    lease_under_lock(layout, base_repo, &identity, request, &fetched).await
}

/// Spare slots this daemon is building outside the pool lock, keyed by pool.
fn warming_spares() -> &'static StdMutex<BTreeSet<(PathBuf, String)>> {
    static WARMING: OnceLock<StdMutex<BTreeSet<(PathBuf, String)>>> = OnceLock::new();
    WARMING.get_or_init(Default::default)
}

fn spare_is_warming(pool_root: &Path, slot_id: &str) -> bool {
    warming_spares()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .contains(&(pool_root.to_path_buf(), slot_id.to_string()))
}

/// Marks a Preparing spare as in flight; dropping it ends that, so an
/// abandoned build is reconciled like any crash intermediate.
struct WarmingSpare(PathBuf, String);

impl WarmingSpare {
    fn begin(pool_root: &Path, slot_id: &SlotId) -> Self {
        let key = (pool_root.to_path_buf(), slot_id.as_str().to_string());
        warming_spares()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(key.clone());
        Self(key.0, key.1)
    }
}

impl Drop for WarmingSpare {
    fn drop(&mut self) {
        warming_spares()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&(self.0.clone(), self.1.clone()));
    }
}

/// Keep one Available slot checked out ahead of demand. A new session then
/// takes it with a reset onto the fresh base instead of a full checkout, which
/// on a loaded machine costs minutes. The checkout runs outside the pool lock
/// so retain/return/lease on the same repository never wait behind it.
/// Returns true when a spare was built.
pub async fn ensure_warm_spare_at(
    layout: &RepoPoolLayout,
    base_repo: &Path,
    canonical_repo: &str,
) -> Result<bool, PoolError> {
    let identity = canonical_repo_identity(canonical_repo)?;
    if repo_key_id(&identity).as_str() != layout.repo_key().as_str() {
        return Err(PoolError::new(
            PoolErrorCode::ManifestMismatch,
            "layout repo key does not match identity",
        ));
    }
    let fetch_repo = fetch_repo_for_pool(layout, base_repo);
    let fetched = required_fetch_and_resolve(&fetch_repo).await?;
    let pool_root = layout.pool_root();
    let (slot_id, path, pinned_base, warming) = {
        let _guard = acquire_pool_guard(layout).await?;
        let Some(mut manifest) = load_for_update(layout)? else {
            return Ok(false);
        };
        if manifest.canonical_repo_identity != identity.as_str() {
            return Err(PoolError::new(
                PoolErrorCode::ManifestMismatch,
                "pool identity mismatch",
            ));
        }
        let has_spare = manifest
            .slots
            .values()
            .any(|slot| matches!(slot.state, SlotState::Available | SlotState::Preparing));
        if has_spare || crate::run_worktree::new_worktree_storage_denied_reason(pool_root).is_some()
        {
            return Ok(false);
        }
        verify_base_matches_identity(base_repo, &identity).await?;
        let pinned_base = resolve_pinned_pool_base(&mut manifest, base_repo, &identity).await?;
        let (slot_id, path) = insert_preparing_slot(layout, &mut manifest)?;
        let warming = WarmingSpare::begin(pool_root, &slot_id);
        save_manifest_at(pool_root, &manifest)?;
        (slot_id, path, pinned_base, warming)
    };
    let fetched_on_pin = fetched_for_pinned_base(&fetch_repo, &pinned_base, &fetched).await;
    let built = match fetched_on_pin {
        Ok(fetched) => match create_linked_slot_required_fetch(&pinned_base, &path, &fetched).await
        {
            Ok(base) => match verify_worktree_belongs_to_base(&pinned_base, &path).await {
                Ok(()) => lock_pool_worktree(&pinned_base, &path, layout, &slot_id)
                    .await
                    .map(|()| base),
                Err(error) => Err(error),
            },
            Err(error) => Err(error),
        },
        Err(error) => Err(error),
    };
    let _guard = acquire_pool_guard(layout).await?;
    let mut manifest = load_for_update(layout)?
        .ok_or_else(|| PoolError::new(PoolErrorCode::ManifestCorrupt, "pool manifest vanished"))?;
    drop(warming);
    match built {
        Ok((base_ref, base_oid)) => {
            let slot = manifest.slots.get_mut(slot_id.as_str()).ok_or_else(|| {
                PoolError::new(PoolErrorCode::InvalidSlotId, "warming spare slot missing")
            })?;
            slot.state = SlotState::Available;
            slot.last_base_ref = Some(base_ref);
            slot.last_base_oid = Some(base_oid);
            slot.updated_at = now_rfc3339();
            save_manifest_at(pool_root, &manifest)?;
            Ok(true)
        }
        Err(error) if path.exists() => finalize_create_failure(
            pool_root,
            &mut manifest,
            layout,
            &pinned_base,
            &path,
            &slot_id,
            error,
        )
        .await
        .map(|_| false),
        Err(error) => {
            drop_slot_from_manifest(&mut manifest, slot_id.as_str());
            save_manifest_at(pool_root, &manifest)?;
            Err(error)
        }
    }
}

pub async fn mark_retained_at(
    layout: &RepoPoolLayout,
    request: &LeaseRequest,
) -> Result<(), PoolError> {
    validate_request(request)?;
    let _guard = acquire_pool_guard(layout).await?;
    let manifest = load_for_update(layout)?
        .ok_or_else(|| PoolError::new(PoolErrorCode::ManifestCorrupt, "pool manifest missing"))?;
    retain_bound_slot(layout, manifest, request)
}

/// Retain the slot of a Run that exited. A reborn or resume may already have
/// bound the session's slot to its successor Run; this Run then holds no
/// binding and nothing is left to retain (`Ok(false)`), but its exit is still
/// owed to Authority.
pub async fn retain_exited_at(
    layout: &RepoPoolLayout,
    request: &LeaseRequest,
) -> Result<bool, PoolError> {
    validate_request(request)?;
    let _guard = acquire_pool_guard(layout).await?;
    let manifest = load_for_update(layout)?
        .ok_or_else(|| PoolError::new(PoolErrorCode::ManifestCorrupt, "pool manifest missing"))?;
    if find_exact_binding(&manifest, request).is_err() {
        return Ok(false);
    }
    retain_bound_slot(layout, manifest, request).map(|()| true)
}

fn retain_bound_slot(
    layout: &RepoPoolLayout,
    mut manifest: RepoPoolManifest,
    request: &LeaseRequest,
) -> Result<(), PoolError> {
    let slot_id = find_exact_binding(&manifest, request)?.slot_id.clone();
    let slot = manifest
        .slots
        .get_mut(&slot_id)
        .ok_or_else(|| PoolError::new(PoolErrorCode::InvalidSlotId, "binding slot missing"))?;
    if !matches!(
        slot.state,
        SlotState::Starting | SlotState::Leased | SlotState::Retained
    ) {
        return Err(PoolError::new(
            PoolErrorCode::InvalidBinding,
            "slot cannot retain from current state",
        ));
    }
    slot.state = SlotState::Retained;
    slot.spawn_claim_token = None;
    slot.updated_at = now_rfc3339();
    slot.quarantine_code = None;
    save_manifest_at(layout.pool_root(), &manifest)
}

pub async fn retained_binding_for_session_at(
    layout: &RepoPoolLayout,
    session_key: &str,
) -> Result<RetainedLease, PoolError> {
    let retained = retained_authority_for_session_at(layout, session_key).await?;
    let slot_id = SlotId::parse(&retained.authority.slot_id)?;
    if !layout.slot_path(&slot_id)?.join(".git").is_file() {
        return Err(PoolError::new(
            PoolErrorCode::WorktreeMissing,
            "retained worktree missing",
        ));
    }
    Ok(retained)
}

/// The session's retained binding, whether or not its tree is still on disk.
async fn retained_authority_for_session_at(
    layout: &RepoPoolLayout,
    session_key: &str,
) -> Result<RetainedLease, PoolError> {
    validate_binding_field("sessionKey", session_key)?;
    let _guard = acquire_pool_guard(layout).await?;
    let manifest = load_for_update(layout)?
        .ok_or_else(|| PoolError::new(PoolErrorCode::ManifestCorrupt, "pool manifest missing"))?;
    let mut matches = manifest
        .bindings
        .iter()
        .filter(|binding| binding.session_key == session_key);
    let binding = matches
        .next()
        .ok_or_else(|| PoolError::new(PoolErrorCode::InvalidBinding, "retained session missing"))?;
    if matches.next().is_some() {
        return Err(PoolError::new(
            PoolErrorCode::ManifestCorrupt,
            "retained session is not unique",
        ));
    }
    require_retained_slot(&manifest, &binding.slot_id)?;
    SlotId::parse(&binding.slot_id)?;
    Ok(RetainedLease {
        authority: binding.authority(),
        canonical_repo_identity: manifest.canonical_repo_identity,
    })
}

fn require_retained_slot(manifest: &RepoPoolManifest, slot_id: &str) -> Result<(), PoolError> {
    let slot = manifest.slots.get(slot_id)
        .ok_or_else(|| PoolError::new(PoolErrorCode::InvalidSlotId, "binding slot missing"))?;
    if slot.state != SlotState::Retained {
        return Err(PoolError::new(
            PoolErrorCode::InvalidBinding,
            "session binding is not retained",
        ));
    }
    Ok(())
}

/// The retained slot this machine holds for `session_key`, if it holds any.
///
/// A reborn that reaches the daemon without Hub-issued pool authority (a Hub
/// that dropped it, or a predecessor whose spawn result never recorded it) is
/// still the same session: if this machine retained a slot for it, that slot is
/// the only directory the harness session can resume in. `Ok(None)` means the
/// machine never bound the session to a pool slot. A slot whose tree is gone,
/// by the sweep or behind the pool's back, still answers: reborn recreates it
/// at the same path. A binding that cannot be reborn (not retained, corrupt
/// manifest) is an error, never a reason to fall back to a new tree.
pub async fn retained_binding_for_unissued_reborn_at(
    trusted_pools_root: &Path,
    repo_key: &RepoKeyId,
    session_key: &str,
) -> Result<Option<RetainedLease>, PoolError> {
    let pooled = [repo_key.as_str(), &repo_key.as_str()[..POOL_DIR_KEY_CHARS]]
        .iter()
        .any(|name| trusted_pools_root.join(name).join(MANIFEST_FILE).is_file());
    if !pooled {
        return Ok(None);
    }
    let layout = RepoPoolLayout::create(trusted_pools_root, repo_key.clone())?;
    {
        let _guard = acquire_pool_guard(&layout).await?;
        let Some(manifest) = load_for_update(&layout)? else {
            return Ok(None);
        };
        if !manifest
            .bindings
            .iter()
            .any(|binding| binding.session_key == session_key)
        {
            return Ok(load_rehydrate_records(&layout)?
                .into_iter()
                .find(|record| record.session_key == session_key)
                .map(|record| RetainedLease {
                    authority: BindingAuthority {
                        session_key: record.session_key,
                        instance_id: record.instance_id,
                        run_id: record.run_id,
                        execution_key: record.execution_key,
                        slot_id: record.slot_id,
                    },
                    canonical_repo_identity: manifest.canonical_repo_identity,
                }));
        }
    }
    retained_authority_for_session_at(&layout, session_key)
        .await
        .map(Some)
}

/// The daemon consumes the exact one-shot token immediately before OS spawn.
/// Token rotation on an exact replay fences a stale pre-spawn command from a
/// daemon generation that crashed before durable child registration.
pub async fn claim_starting_lease_at(
    layout: &RepoPoolLayout,
    authority: &BindingAuthority,
    spawn_claim_token: &str,
    daemon_spawn_cwd: &Path,
) -> Result<(), PoolError> {
    validate_authority(authority)?;
    validate_spawn_claim_token(spawn_claim_token)?;
    let _guard = acquire_pool_guard(layout).await?;
    let mut manifest = load_for_update(layout)?
        .ok_or_else(|| PoolError::new(PoolErrorCode::ManifestCorrupt, "pool manifest missing"))?;
    let idx = find_exact_authority_index(&manifest, authority)?;
    let binding = manifest
        .bindings
        .get(idx)
        .expect("validated exact binding remains present")
        .clone();
    let slot_id = SlotId::parse(&binding.slot_id)?;
    let expected_worktree = layout.slot_path(&slot_id)?;
    let slot = manifest
        .slots
        .get(&binding.slot_id)
        .ok_or_else(|| PoolError::new(PoolErrorCode::InvalidSlotId, "binding slot missing"))?;
    if slot.state != SlotState::Starting
        || slot.spawn_claim_token.as_deref() != Some(spawn_claim_token)
    {
        return Err(PoolError::new(
            PoolErrorCode::InvalidBinding,
            "daemon spawn claim is stale or already consumed",
        ));
    }
    let expected_cwd =
        strip_extended_length_prefix(std::fs::canonicalize(&expected_worktree).map_err(|_| {
            PoolError::new(
                PoolErrorCode::WorktreeMissing,
                "daemon spawn worktree is unavailable",
            )
        })?);
    let actual_cwd =
        strip_extended_length_prefix(std::fs::canonicalize(daemon_spawn_cwd).map_err(|_| {
            PoolError::new(PoolErrorCode::PathEscape, "daemon spawn cwd is unavailable")
        })?);
    if !paths_equal_platform(&expected_cwd, &actual_cwd) {
        return Err(PoolError::new(
            PoolErrorCode::PathEscape,
            "daemon spawn cwd does not match its leased slot",
        ));
    }
    let base_repo = registered_base_repo_for_worktree(&expected_worktree).await?;
    let identity = canonical_repo_identity(&manifest.canonical_repo_identity)?;
    verify_base_matches_identity(&base_repo, &identity).await?;
    verify_pool_worktree_ownership(layout, &base_repo, &expected_worktree, &slot_id).await?;
    let slot = manifest
        .slots
        .get_mut(&binding.slot_id)
        .expect("validated starting slot remains present");
    slot.state = SlotState::Leased;
    slot.spawn_claim_token = None;
    slot.updated_at = now_rfc3339();
    save_manifest_at(layout.pool_root(), &manifest)
}

/// Two-phase rebind: exact expected old binding (incl. slotId) + replacement authority.
/// L1: only Retained → Starting; the daemon claims Starting → Leased
/// immediately before OS spawn.
/// replacement.session_key must equal expected (same cwd session).
pub async fn rebind_retained_lease_at(
    layout: &RepoPoolLayout,
    base_repo: &Path,
    expected: &BindingAuthority,
    replacement: &LeaseRequest,
) -> Result<LeaseResult, PoolError> {
    validate_authority(expected)?;
    validate_request(replacement)?;
    // Session continuity: reborn keeps the same session_key (same cwd identity).
    if replacement.session_key != expected.session_key {
        return Err(PoolError::new(
            PoolErrorCode::InvalidBinding,
            "replacement sessionKey must equal expected sessionKey",
        ));
    }
    transfer_retained_binding(
        layout,
        base_repo,
        expected,
        replacement,
        RetainedTransferMode::Reborn,
    )
    .await
}

/// Same-machine handoff: transfer a Retained slot to a new writer without
/// reset/clean. Unlike reborn, the successor may use a different session_key.
pub async fn transfer_retained_lease_at(
    layout: &RepoPoolLayout,
    base_repo: &Path,
    expected: &BindingAuthority,
    replacement: &LeaseRequest,
) -> Result<LeaseResult, PoolError> {
    validate_authority(expected)?;
    validate_request(replacement)?;
    transfer_retained_binding(
        layout,
        base_repo,
        expected,
        replacement,
        RetainedTransferMode::Handoff,
    )
    .await
}

enum RetainedTransferMode {
    Reborn,
    Handoff,
}

async fn transfer_retained_binding(
    layout: &RepoPoolLayout,
    base_repo: &Path,
    expected: &BindingAuthority,
    replacement: &LeaseRequest,
    mode: RetainedTransferMode,
) -> Result<LeaseResult, PoolError> {
    let (state_error, worktree_error, base_ref_error, session_key) = match mode {
        RetainedTransferMode::Reborn => (
            "rebind only allowed from Retained",
            "reborn worktree missing",
            "reborn missing lastBaseRef",
            expected.session_key.as_str(),
        ),
        RetainedTransferMode::Handoff => (
            "handoff transfer only allowed from Retained",
            "handoff worktree missing",
            "handoff missing lastBaseRef",
            replacement.session_key.as_str(),
        ),
    };
    // Reject non-Retained writers before probing ownership or quarantining.
    let _guard = acquire_pool_guard(layout).await?;
    let mut manifest = load_for_update(layout)?
        .ok_or_else(|| PoolError::new(PoolErrorCode::ManifestCorrupt, "pool manifest missing"))?;
    let idx = find_exact_authority_index(&manifest, expected)?;
    let slot_id = SlotId::parse(&expected.slot_id)?;
    let path = layout.slot_path(&slot_id)?;
    {
        let slot = manifest
            .slots
            .get(slot_id.as_str())
            .ok_or_else(|| PoolError::new(PoolErrorCode::InvalidSlotId, "slot missing"))?;
        if slot.state != SlotState::Retained {
            return Err(PoolError::new(PoolErrorCode::InvalidBinding, state_error));
        }
    }
    let identity = canonical_repo_identity(&manifest.canonical_repo_identity)?;
    quarantine_if_verification_failed(
        verify_base_matches_identity(base_repo, &identity).await,
        layout,
        &mut manifest,
        &slot_id,
    )?;
    if !path.join(".git").is_file() {
        return Err(PoolError::new(
            PoolErrorCode::WorktreeMissing,
            worktree_error,
        ));
    }
    quarantine_if_verification_failed(
        verify_pool_worktree_ownership(layout, base_repo, &path, &slot_id).await,
        layout,
        &mut manifest,
        &slot_id,
    )?;
    let slot = manifest
        .slots
        .get_mut(slot_id.as_str())
        .ok_or_else(|| PoolError::new(PoolErrorCode::InvalidSlotId, "slot missing"))?;
    let base_ref = slot
        .last_base_ref
        .clone()
        .ok_or_else(|| PoolError::new(PoolErrorCode::ManifestCorrupt, base_ref_error))?;
    let spawn_claim_token = fresh_spawn_claim_token();
    slot.state = SlotState::Starting;
    slot.spawn_claim_token = Some(spawn_claim_token.clone());
    slot.updated_at = now_rfc3339();
    manifest.bindings[idx] = BindingRecord {
        session_key: session_key.to_string(),
        instance_id: replacement.instance_id.clone(),
        run_id: replacement.run_id.clone(),
        execution_key: replacement.execution_key.clone(),
        slot_id: slot_id.as_str().to_string(),
    };
    save_manifest_at(layout.pool_root(), &manifest)?;
    Ok(LeaseResult {
        slot_id,
        worktree_path: path,
        base_ref,
        reused_available: false,
        spawn_claim_token,
    })
}

/// Abandon/return. The caller must already have stopped the process tree.
pub async fn return_abandoned_slot_at(
    layout: &RepoPoolLayout,
    base_repo: &Path,
    request: &LeaseRequest,
) -> Result<(), PoolError> {
    validate_request(request)?;
    let fetch_repo = fetch_repo_for_pool(layout, base_repo);
    let fetched = required_fetch_and_resolve(&fetch_repo).await;
    let _guard = acquire_pool_guard(layout).await?;
    finish_return_after_fetch(layout, base_repo, request, None, false, fetched).await
}

pub async fn return_abandoned_authority_at(
    layout: &RepoPoolLayout,
    base_repo: &Path,
    authority: &BindingAuthority,
) -> Result<(), PoolError> {
    validate_authority(authority)?;
    let request = LeaseRequest::from_authority(authority);
    let fetch_repo = fetch_repo_for_pool(layout, base_repo);
    let fetched = required_fetch_and_resolve(&fetch_repo).await;
    let _guard = acquire_pool_guard(layout).await?;
    finish_return_after_fetch(layout, base_repo, &request, Some(authority), false, fetched).await
}

/// No-live-registry abandon may consume only an already Retained binding (the
/// process-tree stop evidence) or an exact completed-return receipt.
/// Return an exact retained binding after a daemon restart no longer has the
/// original registry row (and therefore no trusted base checkout path). The
/// base is recovered from Git's registered common-dir, never from the slot path
/// supplied by the request.
pub async fn return_retained_authority_without_base_at(
    layout: &RepoPoolLayout,
    authority: &BindingAuthority,
) -> Result<(), PoolError> {
    validate_authority(authority)?;
    let request = LeaseRequest::from_authority(authority);
    let slot_id = SlotId::parse(&authority.slot_id)?;
    let worktree = layout.slot_path(&slot_id)?;
    let base_repo = registered_base_repo_for_worktree(&worktree).await?;
    let fetched = required_fetch_and_resolve(&base_repo).await;
    let _guard = acquire_pool_guard(layout).await?;
    finish_return_after_fetch(layout, &base_repo, &request, Some(authority), true, fetched).await
}

/// Check the exact durable receipt written only after a typed abandon made the
/// slot Available and removed its live binding. This closes the registry-write
/// crash window without treating a merely missing binding as success.
pub async fn completed_return_receipt_matches_at(
    layout: &RepoPoolLayout,
    authority: &BindingAuthority,
) -> Result<bool, PoolError> {
    validate_authority(authority)?;
    let _guard = acquire_pool_guard(layout).await?;
    let Some(manifest) = load_manifest_at(layout.pool_root())? else {
        return Ok(false);
    };
    if manifest.repo_key_id != layout.repo_key().as_str() {
        return Err(PoolError::new(
            PoolErrorCode::ManifestMismatch,
            "pool identity mismatch",
        ));
    }
    Ok(manifest
        .slots
        .get(&authority.slot_id)
        .and_then(|slot| slot.last_returned_binding.as_ref())
        .is_some_and(|receipt| binding_record_matches_authority(receipt, authority)))
}

// --- lock-held ops ---

async fn lease_under_lock(
    layout: &RepoPoolLayout,
    base_repo: &Path,
    identity: &CanonicalRepoIdentity,
    request: &LeaseRequest,
    fetched: &ResolvedBase,
) -> Result<LeaseResult, PoolError> {
    let pool_root = layout.pool_root();
    // Order: lock already held by caller; reconcile+persist BEFORE any base/Git checks
    // so early returns still leave crash intermediates durably Quarantined.
    let mut manifest = match load_for_update(layout)? {
        Some(m) => {
            if m.repo_key_id != layout.repo_key().as_str()
                || m.canonical_repo_identity != identity.as_str()
            {
                return Err(PoolError::new(
                    PoolErrorCode::ManifestMismatch,
                    "pool identity mismatch",
                ));
            }
            m
        }
        None => RepoPoolManifest {
            version: layout.manifest_version(),
            canonical_repo_identity: identity.as_str().to_string(),
            repo_key_id: layout.repo_key().as_str().to_string(),
            base_repo_path: None,
            slots: BTreeMap::new(),
            bindings: Vec::new(),
        },
    };
    verify_base_matches_identity(base_repo, identity).await?;
    let pinned_base = resolve_pinned_pool_base(&mut manifest, base_repo, identity).await?;
    let fetched_on_pin = fetched_for_pinned_base(base_repo, &pinned_base, fetched).await?;
    let fetched = fetched_on_pin.as_ref();
    let base_repo = pinned_base.as_path();
    readmit_quarantined_slots_matching_base(layout, base_repo, pool_root, &mut manifest).await?;

    if let Some(existing) = manifest
        .bindings
        .iter()
        .find(|b| b.session_key == request.session_key)
        .cloned()
    {
        let exact_retry = existing.instance_id == request.instance_id
            && existing.run_id == request.run_id
            && existing.execution_key == request.execution_key;
        let slot_id = SlotId::parse(&existing.slot_id)?;
        let path = layout.slot_path(&slot_id)?;
        let state = manifest
            .slots
            .get(slot_id.as_str())
            .ok_or_else(|| PoolError::new(PoolErrorCode::InvalidSlotId, "binding slot missing"))?
            .state;
        if exact_retry && state == SlotState::Starting {
            // The previous daemon durably bound the slot but never completed
            // pre-spawn admission. Rotate the token under the daemon's repo
            // coordinator so a stale command is fenced and the exact replay
            // can start one replacement in the same linked worktree.
            verify_pool_worktree_ownership(layout, base_repo, &path, &slot_id).await?;
            let spawn_claim_token = fresh_spawn_claim_token();
            let slot = manifest
                .slots
                .get_mut(slot_id.as_str())
                .expect("validated retry slot remains present");
            let base_ref = slot.last_base_ref.clone().ok_or_else(|| {
                PoolError::new(
                    PoolErrorCode::ManifestCorrupt,
                    "starting slot missing lastBaseRef",
                )
            })?;
            slot.spawn_claim_token = Some(spawn_claim_token.clone());
            slot.updated_at = now_rfc3339();
            save_manifest_at(pool_root, &manifest)?;
            return Ok(LeaseResult {
                slot_id,
                worktree_path: path,
                base_ref,
                reused_available: false,
                spawn_claim_token,
            });
        }
        return Err(PoolError::new(
            PoolErrorCode::InvalidBinding,
            if exact_retry {
                "exact session is already claimed by a daemon spawn"
            } else {
                "session already bound; use rebind for reborn"
            },
        ));
    }

    for slot_id in broken_retained_slots(layout, &manifest) {
        // A resting session keeps its way back: record its checkout first.
        match record_lost_checkout(layout, base_repo, &mut manifest, &slot_id).await {
            Ok(true) => {
                save_manifest_at(pool_root, &manifest)?;
                continue;
            }
            Ok(false) => {}
            Err(error) => {
                eprintln!("repo pool: keeping lost retained slot {slot_id} ({error})");
                continue;
            }
        }
        let parsed = SlotId::parse(&slot_id)?;
        let path = layout.slot_path(&parsed)?;
        discard_broken_idle_slot(layout, base_repo, pool_root, &mut manifest, &parsed, &path)
            .await?;
    }
    loop {
        // Grow rather than displace a resting session; the reclaim sweep, not a
        // new lease, gives a resting slot's disk back.
        let storage_denied = crate::run_worktree::new_worktree_storage_denied_reason(pool_root);
        if let Some(slot_id) = pick_idle_pool_slot(&manifest) {
            let parsed = SlotId::parse(&slot_id)?;
            let path = layout.slot_path(&parsed)?;
            // A new :new/:once lease is keyed only by repo identity. An idle
            // managed slot that is no longer a formal linked worktree is
            // leftover product cache — remove it and keep looking. A formal
            // tree registered to a different clone of the same remote is also
            // leftover: detach it from that foreign parent and continue. Trees
            // that still belong to this pool parent but fail ownership stay
            // quarantined (foreign lock, verify drift).
            if !path.join(".git").is_file() {
                discard_broken_idle_slot(
                    layout,
                    base_repo,
                    pool_root,
                    &mut manifest,
                    &parsed,
                    &path,
                )
                .await?;
                continue;
            }
            if let Err(err) =
                verify_pool_worktree_ownership(layout, base_repo, &path, &parsed).await
            {
                if discard_foreign_parent_idle_slot(
                    layout,
                    base_repo,
                    pool_root,
                    &mut manifest,
                    &parsed,
                    &path,
                )
                .await?
                {
                    continue;
                }
                quarantine_slot_only(&mut manifest, parsed.as_str(), err.code);
                save_manifest_at(pool_root, &manifest)?;
                continue;
            }
            return refresh_idle_slot(
                layout,
                base_repo,
                pool_root,
                &mut manifest,
                &slot_id,
                request,
                fetched,
            )
            .await;
        }
        if let Some(reason) = storage_denied {
            return Err(PoolError::new(PoolErrorCode::DiskExhausted, reason));
        }
        let (slot_id, path) = insert_preparing_slot(layout, &mut manifest)?;
        save_manifest_at(pool_root, &manifest)?;

        return match create_linked_slot_required_fetch(base_repo, &path, fetched).await {
            Ok((base_ref, base_oid)) => {
                if let Err(err) = verify_worktree_belongs_to_base(base_repo, &path).await {
                    // Created this op: try safe git remove; never raw remove_dir_all.
                    // Cleanup failure takes priority (never swallow).
                    return finalize_create_failure(
                        pool_root,
                        &mut manifest,
                        layout,
                        base_repo,
                        &path,
                        &slot_id,
                        err,
                    )
                    .await;
                }
                if let Err(err) = lock_pool_worktree(base_repo, &path, layout, &slot_id).await {
                    return finalize_create_failure(
                        pool_root,
                        &mut manifest,
                        layout,
                        base_repo,
                        &path,
                        &slot_id,
                        err,
                    )
                    .await;
                }
                let spawn_claim_token = bind_new_starting_slot(
                    pool_root,
                    &mut manifest,
                    &slot_id,
                    request,
                    &base_ref,
                    &base_oid,
                )?;
                Ok(LeaseResult {
                    slot_id,
                    worktree_path: path,
                    base_ref,
                    reused_available: false,
                    spawn_claim_token,
                })
            }
            Err(err) => {
                // May have partially created a linked tree; safe cleanup only.
                if path.exists() {
                    return finalize_create_failure(
                        pool_root,
                        &mut manifest,
                        layout,
                        base_repo,
                        &path,
                        &slot_id,
                        err,
                    )
                    .await;
                }
                quarantine_slot_only(&mut manifest, slot_id.as_str(), err.code);
                save_manifest_at(pool_root, &manifest)?;
                Err(err)
            }
        };
    }
}

/// Allocate a fresh slot directory and record it as Preparing (not yet saved).
fn insert_preparing_slot(
    layout: &RepoPoolLayout,
    manifest: &mut RepoPoolManifest,
) -> Result<(SlotId, PathBuf), PoolError> {
    let slot_id = allocate_slot_id(layout, manifest, SlotId::generate)?;
    let path = layout.slot_path(&slot_id)?;
    if let Some(parent) = path.parent() {
        create_component_dir_checked(layout.trusted_pools_root(), parent)?;
    }
    manifest.slots.insert(
        slot_id.as_str().to_string(),
        SlotRecord::preparing(&slot_id),
    );
    Ok((slot_id, path))
}

/// A slot a new session may take: an Available one, oldest first. A Retained
/// slot is never taken, however cold: it is where its resting Instance wakes
/// (its harness transcript is keyed by the directory), and the reclaim sweep
/// frees its disk with a rehydrate record instead (docs/instance-sleep.md §6).
/// Live Starting/Leased slots and Quarantined trees are never offered either.
fn pick_idle_pool_slot(manifest: &RepoPoolManifest) -> Option<String> {
    manifest
        .slots
        .iter()
        .filter(|(_, slot)| slot.state == SlotState::Available)
        .min_by(|a, b| {
            a.1.updated_at
                .cmp(&b.1.updated_at)
                .then_with(|| a.0.cmp(b.0))
        })
        .map(|(id, _)| id.clone())
}

fn bind_new_starting_slot(
    pool_root: &Path,
    manifest: &mut RepoPoolManifest,
    slot_id: &SlotId,
    request: &LeaseRequest,
    base_ref: &str,
    base_oid: &str,
) -> Result<String, PoolError> {
    let spawn_claim_token = fresh_spawn_claim_token();
    let slot = manifest
        .slots
        .get_mut(slot_id.as_str())
        .expect("new slot was inserted above");
    slot.state = SlotState::Starting;
    slot.last_base_ref = Some(base_ref.to_string());
    slot.last_base_oid = Some(base_oid.to_string());
    slot.updated_at = now_rfc3339();
    slot.spawn_claim_token = Some(spawn_claim_token.clone());
    manifest
        .bindings
        .push(BindingRecord::for_lease(slot_id, request));
    if let Err(error) = save_manifest_at(pool_root, manifest) {
        // Keep the locked orphan; a secondary failure must not replace the
        // primary error or cause the uncertain tree to be unlocked or removed.
        quarantine_slot_only(manifest, slot_id.as_str(), error.code);
        let _ = save_manifest_at(pool_root, manifest);
        return Err(error);
    }
    Ok(spawn_claim_token)
}

/// Retained slots whose tree lost its linked `.git`. A bound one is recorded
/// for rehydrate before a new lease clears it away; an unbound one is cache.
fn broken_retained_slots(layout: &RepoPoolLayout, manifest: &RepoPoolManifest) -> Vec<String> {
    manifest
        .slots
        .iter()
        .filter(|(_, slot)| slot.state == SlotState::Retained)
        .filter(|(id, _)| {
            layout
                .slot_path_for_id(id)
                .ok()
                .is_some_and(|path| path.exists() && !path.join(".git").is_file())
        })
        .map(|(id, _)| id.clone())
        .collect()
}

/// Reset an idle slot onto a fresh base and hand it to this new session.
/// Retained bindings are replaced; Available slots have no live binding.
async fn refresh_idle_slot(
    layout: &RepoPoolLayout,
    base_repo: &Path,
    pool_root: &Path,
    manifest: &mut RepoPoolManifest,
    slot_id: &str,
    request: &LeaseRequest,
    fetched: &ResolvedBase,
) -> Result<LeaseResult, PoolError> {
    let slot_id = SlotId::parse(slot_id)?;
    let path = layout.slot_path(&slot_id)?;
    if let Err(err) = verify_pool_worktree_ownership(layout, base_repo, &path, &slot_id).await {
        quarantine_slot_only(manifest, slot_id.as_str(), err.code);
        save_manifest_at(pool_root, manifest)?;
        return Err(err);
    }
    {
        let slot = manifest.slots.get_mut(slot_id.as_str()).unwrap();
        slot.state = SlotState::Preparing;
        slot.updated_at = now_rfc3339();
        slot.quarantine_code = None;
        slot.spawn_claim_token = None;
    }
    manifest
        .bindings
        .retain(|binding| binding.slot_id != slot_id.as_str());
    manifest
        .bindings
        .push(BindingRecord::for_lease(&slot_id, request));
    save_manifest_at(pool_root, manifest)?;

    match prepare_fresh_tree(base_repo, &path, slot_id.as_str(), fetched).await {
        Ok((base_ref, base_oid)) => {
            if let Err(err) =
                verify_pool_worktree_ownership(layout, base_repo, &path, &slot_id).await
            {
                quarantine_keep_binding(manifest, slot_id.as_str(), err.code);
                save_manifest_at(pool_root, manifest)?;
                return Err(err);
            }
            let spawn_claim_token = fresh_spawn_claim_token();
            let slot = manifest.slots.get_mut(slot_id.as_str()).unwrap();
            slot.state = SlotState::Starting;
            slot.last_base_ref = Some(base_ref.clone());
            slot.last_base_oid = Some(base_oid.clone());
            slot.updated_at = now_rfc3339();
            slot.quarantine_code = None;
            slot.spawn_claim_token = Some(spawn_claim_token.clone());
            save_manifest_at(pool_root, manifest)?;
            Ok(LeaseResult {
                slot_id,
                worktree_path: path,
                base_ref,
                reused_available: true,
                spawn_claim_token,
            })
        }
        Err(err) => {
            quarantine_keep_binding(manifest, slot_id.as_str(), err.code);
            save_manifest_at(pool_root, manifest)?;
            Err(err)
        }
    }
}

async fn finish_return_after_fetch(
    layout: &RepoPoolLayout,
    base_repo: &Path,
    request: &LeaseRequest,
    expected: Option<&BindingAuthority>,
    require_retained: bool,
    fetched: Result<ResolvedBase, PoolError>,
) -> Result<(), PoolError> {
    if let Some(error) = return_rejected_before_fetch_apply(layout, request, expected)? {
        return Err(error);
    }
    match fetched {
        Ok(fetched) => {
            return_under_lock(
                layout,
                base_repo,
                request,
                expected,
                require_retained,
                &fetched,
            )
            .await
        }
        Err(error) => {
            quarantine_return_prep_failure(layout, request, expected, error.code)?;
            Err(error)
        }
    }
}

fn return_rejected_before_fetch_apply(
    layout: &RepoPoolLayout,
    request: &LeaseRequest,
    expected: Option<&BindingAuthority>,
) -> Result<Option<PoolError>, PoolError> {
    let Some(manifest) = load_for_update(layout)? else {
        return Ok(None);
    };
    match find_exact_binding(&manifest, request) {
        Ok(binding) => {
            if let Some(expected) = expected
                && !binding_record_matches_authority(binding, expected)
            {
                return Ok(Some(PoolError::new(
                    PoolErrorCode::InvalidBinding,
                    "abandon authority does not match exact slot binding",
                )));
            }
            let slot = manifest
                .slots
                .get(&binding.slot_id)
                .ok_or_else(|| PoolError::new(PoolErrorCode::InvalidSlotId, "slot missing"))?;
            if !matches!(
                slot.state,
                SlotState::Starting | SlotState::Leased | SlotState::Retained
            ) {
                return Ok(Some(PoolError::new(
                    PoolErrorCode::InvalidBinding,
                    "return only allowed from Starting, Leased, or Retained",
                )));
            }
            Ok(None)
        }
        Err(_) => Ok(None),
    }
}

fn quarantine_return_prep_failure(
    layout: &RepoPoolLayout,
    request: &LeaseRequest,
    expected: Option<&BindingAuthority>,
    code: PoolErrorCode,
) -> Result<(), PoolError> {
    let Some(mut manifest) = load_for_update(layout)? else {
        return Ok(());
    };
    let Ok(binding) = find_exact_binding(&manifest, request) else {
        return Ok(());
    };
    if let Some(expected) = expected
        && !binding_record_matches_authority(binding, expected)
    {
        return Ok(());
    }
    let slot_id = binding.slot_id.clone();
    quarantine_keep_binding(&mut manifest, &slot_id, code);
    save_manifest_at(layout.pool_root(), &manifest)
}

async fn return_under_lock(
    layout: &RepoPoolLayout,
    base_repo: &Path,
    request: &LeaseRequest,
    expected: Option<&BindingAuthority>,
    require_retained: bool,
    fetched: &ResolvedBase,
) -> Result<(), PoolError> {
    let pool_root = layout.pool_root();
    let mut manifest = load_for_update(layout)?
        .ok_or_else(|| PoolError::new(PoolErrorCode::ManifestCorrupt, "pool manifest missing"))?;
    let binding = match find_exact_binding(&manifest, request) {
        Ok(binding) => binding.clone(),
        Err(error) => {
            if let Some(expected) = expected {
                let already_returned = manifest
                    .slots
                    .get(&expected.slot_id)
                    .and_then(|slot| slot.last_returned_binding.as_ref())
                    .map(|receipt| binding_record_matches_authority(receipt, expected))
                    .unwrap_or(false);
                if already_returned {
                    return Ok(());
                }
            }
            return Err(error);
        }
    };
    if let Some(expected) = expected
        && !binding_record_matches_authority(&binding, expected) {
            return Err(PoolError::new(
                PoolErrorCode::InvalidBinding,
                "abandon authority does not match exact slot binding",
            ));
        }
    let slot_id = SlotId::parse(&binding.slot_id)?;
    let path = layout.slot_path(&slot_id)?;

    // Starting is also safe after the caller has stopped/fenced the exact
    // wrapper process tree; the claim token is invalidated before Git mutation.
    {
        let slot = manifest
            .slots
            .get(slot_id.as_str())
            .ok_or_else(|| PoolError::new(PoolErrorCode::InvalidSlotId, "slot missing"))?;
        if require_retained && slot.state != SlotState::Retained {
            return Err(PoolError::new(
                PoolErrorCode::InvalidBinding,
                "return without live registry requires retained stop evidence",
            ));
        }
        if !matches!(
            slot.state,
            SlotState::Starting | SlotState::Leased | SlotState::Retained
        ) {
            return Err(PoolError::new(
                PoolErrorCode::InvalidBinding,
                "return only allowed from Starting, Leased, or Retained",
            ));
        }
    }

    let identity = canonical_repo_identity(&manifest.canonical_repo_identity)?;
    quarantine_if_verification_failed(
        verify_base_matches_identity(base_repo, &identity).await,
        layout,
        &mut manifest,
        &slot_id,
    )?;
    let pinned_base = resolve_pinned_pool_base(&mut manifest, base_repo, &identity).await?;
    let fetched_on_pin = fetched_for_pinned_base(base_repo, &pinned_base, fetched).await?;
    let fetched = fetched_on_pin.as_ref();
    let base_repo = pinned_base.as_path();
    // Ownership (containment + common-dir + expected pool lock) before state change.
    quarantine_if_verification_failed(
        verify_pool_worktree_ownership(layout, base_repo, &path, &slot_id).await,
        layout,
        &mut manifest,
        &slot_id,
    )?;

    {
        let slot = manifest.slots.get_mut(slot_id.as_str()).unwrap();
        slot.state = SlotState::Returning;
        slot.spawn_claim_token = None;
        slot.updated_at = now_rfc3339();
        slot.quarantine_code = None;
    }
    save_manifest_at(pool_root, &manifest)?;

    match prepare_fresh_tree(base_repo, &path, slot_id.as_str(), fetched).await {
        Ok((base_ref, base_oid)) => {
            // Keep our lock for Available retention in pool.
            quarantine_if_verification_failed(
                verify_pool_worktree_ownership(layout, base_repo, &path, &slot_id).await,
                layout,
                &mut manifest,
                &slot_id,
            )?;
            let slot = manifest.slots.get_mut(slot_id.as_str()).unwrap();
            slot.state = SlotState::Available;
            slot.last_base_ref = Some(base_ref);
            slot.last_base_oid = Some(base_oid);
            slot.updated_at = now_rfc3339();
            slot.quarantine_code = None;
            slot.spawn_claim_token = None;
            slot.last_returned_binding = Some(binding.clone());
            manifest
                .bindings
                .retain(|b| b.session_key != request.session_key);
            save_manifest_at(pool_root, &manifest)?;
            Ok(())
        }
        Err(err) => {
            quarantine_keep_binding(&mut manifest, slot_id.as_str(), err.code);
            save_manifest_at(pool_root, &manifest)?;
            Err(err)
        }
    }
}

fn binding_record_matches_authority(binding: &BindingRecord, authority: &BindingAuthority) -> bool {
    binding.session_key == authority.session_key
        && binding.instance_id == authority.instance_id
        && binding.run_id == authority.run_id
        && binding.execution_key == authority.execution_key
        && binding.slot_id == authority.slot_id
}

fn find_exact_binding<'a>(
    manifest: &'a RepoPoolManifest,
    request: &LeaseRequest,
) -> Result<&'a BindingRecord, PoolError> {
    manifest
        .bindings
        .iter()
        .find(|b| {
            b.session_key == request.session_key
                && b.instance_id == request.instance_id
                && b.run_id == request.run_id
                && b.execution_key == request.execution_key
        })
        .ok_or_else(|| {
            PoolError::new(
                PoolErrorCode::InvalidBinding,
                "exact binding (session,instance,run,execution) not found",
            )
        })
}

fn find_exact_authority_index(
    manifest: &RepoPoolManifest,
    expected: &BindingAuthority,
) -> Result<usize, PoolError> {
    manifest
        .bindings
        .iter()
        .position(|b| {
            b.session_key == expected.session_key
                && b.instance_id == expected.instance_id
                && b.run_id == expected.run_id
                && b.execution_key == expected.execution_key
                && b.slot_id == expected.slot_id
        })
        .ok_or_else(|| {
            PoolError::new(
                PoolErrorCode::InvalidBinding,
                "exact old binding (session,instance,run,execution,slot) not found",
            )
        })
}

fn validate_request(request: &LeaseRequest) -> Result<(), PoolError> {
    validate_binding_field("sessionKey", &request.session_key)?;
    validate_binding_field("instanceId", &request.instance_id)?;
    validate_binding_field("runId", &request.run_id)?;
    validate_binding_field("executionKey", &request.execution_key)?;
    Ok(())
}

fn validate_authority(auth: &BindingAuthority) -> Result<(), PoolError> {
    validate_binding_field("sessionKey", &auth.session_key)?;
    validate_binding_field("instanceId", &auth.instance_id)?;
    validate_binding_field("runId", &auth.run_id)?;
    validate_binding_field("executionKey", &auth.execution_key)?;
    let _ = SlotId::parse(&auth.slot_id)?;
    Ok(())
}

fn quarantine_if_verification_failed(
    verification: Result<(), PoolError>,
    layout: &RepoPoolLayout,
    manifest: &mut RepoPoolManifest,
    slot_id: &SlotId,
) -> Result<(), PoolError> {
    if let Err(error) = verification {
        quarantine_keep_binding(manifest, slot_id.as_str(), error.code);
        // If quarantine cannot be saved, surface that durability failure first.
        save_manifest_at(layout.pool_root(), manifest)?;
        return Err(error);
    }
    Ok(())
}

fn quarantine_keep_binding(manifest: &mut RepoPoolManifest, slot_id: &str, code: PoolErrorCode) {
    if let Some(slot) = manifest.slots.get_mut(slot_id) {
        slot.state = SlotState::Quarantined;
        slot.quarantine_code = Some(code);
        slot.spawn_claim_token = None;
        slot.updated_at = now_rfc3339();
    }
}

fn quarantine_slot_only(manifest: &mut RepoPoolManifest, slot_id: &str, code: PoolErrorCode) {
    quarantine_keep_binding(manifest, slot_id, code);
}

fn drop_slot_from_manifest(manifest: &mut RepoPoolManifest, slot_id: &str) {
    manifest.slots.remove(slot_id);
    manifest
        .bindings
        .retain(|binding| binding.slot_id != slot_id);
}

/// Remove leftover cache for an idle Available/Retained slot that is not a
/// formal linked worktree. Starting/Leased are never offered here. Cleanup
/// failure quarantines the slot so a later pass can retry; the new lease
/// still continues. Exact reborn does not use this path.
async fn discard_broken_idle_slot(
    layout: &RepoPoolLayout,
    base_repo: &Path,
    pool_root: &Path,
    manifest: &mut RepoPoolManifest,
    slot_id: &SlotId,
    path: &Path,
) -> Result<(), PoolError> {
    match remove_leftover_idle_slot_directory(layout, base_repo, path).await {
        Ok(()) => drop_slot_from_manifest(manifest, slot_id.as_str()),
        Err(err) => quarantine_slot_only(manifest, slot_id.as_str(), err.code),
    }
    save_manifest_at(pool_root, manifest)
}

fn canonicalize_pool_base_path(base_repo: &Path) -> Result<PathBuf, PoolError> {
    if !base_repo.is_absolute() {
        return Err(PoolError::new(
            PoolErrorCode::PathEscape,
            "pool base must be absolute",
        ));
    }
    reject_path_components(base_repo)?;
    let canon = std::fs::canonicalize(base_repo).map_err(|_| {
        PoolError::new(PoolErrorCode::VerifyFailed, "canonicalize pool base failed")
    })?;
    Ok(strip_extended_length_prefix(canon))
}

/// Best-effort parent for the pre-lock fetch. The lock still re-resolves pin
/// and re-fetches if this peek is stale or a later workspace was supplied.
fn peek_pinned_base_repo(layout: &RepoPoolLayout) -> Option<PathBuf> {
    let manifest = load_manifest_at(layout.pool_root()).ok().flatten()?;
    let path = PathBuf::from(manifest.base_repo_path?);
    if path.is_absolute() && path.exists() {
        Some(path)
    } else {
        None
    }
}

fn fetch_repo_for_pool(layout: &RepoPoolLayout, provided: &Path) -> PathBuf {
    peek_pinned_base_repo(layout).unwrap_or_else(|| provided.to_path_buf())
}

/// One repo-identity pool has one durable parent checkout. A later workspace
/// checkout of the same remote is ignored so slots never mix git common-dirs.
async fn resolve_pinned_pool_base(
    manifest: &mut RepoPoolManifest,
    provided: &Path,
    identity: &CanonicalRepoIdentity,
) -> Result<PathBuf, PoolError> {
    let provided_c = canonicalize_pool_base_path(provided)?;
    match manifest.base_repo_path.as_deref() {
        None => {
            manifest.base_repo_path = Some(provided_c.display().to_string());
            Ok(provided_c)
        }
        Some(pinned) => {
            let pinned_path = PathBuf::from(pinned);
            if !pinned_path.exists() {
                manifest.base_repo_path = Some(provided_c.display().to_string());
                return Ok(provided_c);
            }
            let pinned_c = canonicalize_pool_base_path(&pinned_path)?;
            if paths_equal_platform(&pinned_c, &provided_c) {
                return Ok(provided_c);
            }
            verify_base_matches_identity(&pinned_c, identity).await?;
            Ok(pinned_c)
        }
    }
}

/// Wrongly quarantined slots that still belong to the pinned parent become
/// Available leftover cache again. Stale bindings are dropped.
async fn readmit_quarantined_slots_matching_base(
    layout: &RepoPoolLayout,
    base_repo: &Path,
    pool_root: &Path,
    manifest: &mut RepoPoolManifest,
) -> Result<(), PoolError> {
    let ids: Vec<String> = manifest.slots.keys().cloned().collect();
    let mut changed = false;
    for id in ids {
        let Some(slot) = manifest.slots.get(&id) else {
            continue;
        };
        if slot.state != SlotState::Quarantined
            || slot.quarantine_code != Some(PoolErrorCode::VerifyFailed)
            || slot.last_base_ref.is_none()
            || slot.last_base_oid.is_none()
        {
            continue;
        }
        let parsed = SlotId::parse(&id)?;
        let path = layout.slot_path(&parsed)?;
        if !path.join(".git").is_file() {
            continue;
        }
        if verify_pool_worktree_ownership(layout, base_repo, &path, &parsed)
            .await
            .is_err()
        {
            continue;
        }
        manifest.bindings.retain(|binding| binding.slot_id != id);
        if let Some(slot) = manifest.slots.get_mut(&id) {
            slot.state = SlotState::Available;
            slot.quarantine_code = None;
            slot.spawn_claim_token = None;
            slot.last_returned_binding = None;
            slot.updated_at = now_rfc3339();
        }
        changed = true;
    }
    if changed {
        save_manifest_at(pool_root, manifest)?;
    }
    Ok(())
}

/// Idle slot whose `.git` points at another clone of the same remote. Detach
/// it from that foreign parent, then treat the directory as leftover cache.
/// Returns true when the slot was removed so the lease can continue.
async fn discard_foreign_parent_idle_slot(
    layout: &RepoPoolLayout,
    base_repo: &Path,
    pool_root: &Path,
    manifest: &mut RepoPoolManifest,
    slot_id: &SlotId,
    path: &Path,
) -> Result<bool, PoolError> {
    let Ok(foreign_base) = registered_base_repo_for_worktree(path).await else {
        return Ok(false);
    };
    let Ok(foreign_c) = canonicalize_pool_base_path(&foreign_base) else {
        return Ok(false);
    };
    let base_c = canonicalize_pool_base_path(base_repo)?;
    if paths_equal_platform(&foreign_c, &base_c) {
        return Ok(false);
    }
    let path_arg = path.display().to_string();
    let _ = git(
        &foreign_base,
        &["worktree", "unlock", &path_arg],
        GIT_LOCAL_TIMEOUT,
    )
    .await;
    let _ = git(
        &foreign_base,
        &["worktree", "remove", "--force", &path_arg],
        GIT_MUTATION_TIMEOUT,
    )
    .await;
    if path.join(".git").is_file() {
        return Ok(false);
    }
    discard_broken_idle_slot(layout, base_repo, pool_root, manifest, slot_id, path).await?;
    Ok(true)
}

/// After a create-path failure: attempt safe cleanup; cleanup errors are never
/// swallowed. Priority: ForeignWorktreeLock > WorktreeCleanupFailed > primary.
async fn finalize_create_failure(
    pool_root: &Path,
    manifest: &mut RepoPoolManifest,
    layout: &RepoPoolLayout,
    base_repo: &Path,
    path: &Path,
    slot_id: &SlotId,
    primary: PoolError,
) -> Result<LeaseResult, PoolError> {
    let returned = match try_safe_remove_created_worktree(layout, base_repo, path, slot_id).await {
        Ok(()) => primary,
        Err(cleanup_err) => match cleanup_err.code {
            PoolErrorCode::ForeignWorktreeLock => cleanup_err,
            PoolErrorCode::WorktreeCleanupFailed => cleanup_err,
            other => PoolError::new(
                PoolErrorCode::WorktreeCleanupFailed,
                format!("cleanup failed after create error ({})", other.as_str()),
            ),
        },
    };
    quarantine_slot_only(manifest, slot_id.as_str(), returned.code);
    save_manifest_at(pool_root, manifest)?;
    Err(returned)
}

// --- git operations (P0-1) ---

async fn create_linked_slot_required_fetch(
    base_repo: &Path,
    path: &Path,
    fetched: &ResolvedBase,
) -> Result<(String, String), PoolError> {
    let (base_ref, base_oid) = (fetched.base_ref.clone(), fetched.oid.clone());
    let path_arg = path.display().to_string();
    // Prefer ref name for add (more portable on Windows); verify exact oid after.
    git(
        base_repo,
        &[
            "-c",
            "worktree.useRelativePaths=false",
            "worktree",
            "add",
            "--detach",
            &path_arg,
            &base_ref,
        ],
        GIT_WORKTREE_ADD_TIMEOUT,
    )
    .await
    .map_err(|error| {
        PoolError::new(
            PoolErrorCode::WorktreeCreateFailed,
            format!("git worktree add failed ({})", error.as_str()),
        )
    })?;
    if !path.join(".git").is_file() {
        return Err(PoolError::new(
            PoolErrorCode::WorktreeCreateFailed,
            "worktree add did not produce linked .git file",
        ));
    }
    // Slot root must be owner-private before any further exposure.
    set_dir_owner_private(path)?;
    // Ensure we landed on the fetched oid (not a stale local tip).
    git(path, &["reset", "--hard", &base_oid], GIT_MUTATION_TIMEOUT)
        .await
        .map_err(|error| {
            PoolError::new(
                PoolErrorCode::WorktreeCreateFailed,
                format!("post-add reset to fetched oid failed ({})", error.as_str()),
            )
        })?;
    verify_tree_at_oid(path, &base_oid).await?;
    Ok((base_ref, base_oid))
}

/// Snapshot (if needed) → apply the repo-level fetched base → hard reset/clean → verify.
async fn prepare_fresh_tree(
    base_repo: &Path,
    path: &Path,
    slot_id: &str,
    fetched: &ResolvedBase,
) -> Result<(String, String), PoolError> {
    let _ = base_repo;
    snapshot_if_needed(path, slot_id).await?;
    let (base_ref, base_oid) = (fetched.base_ref.clone(), fetched.oid.clone());
    git(
        path,
        &["checkout", "--detach", &base_oid],
        GIT_MUTATION_TIMEOUT,
    )
    .await
    .map_err(|_| PoolError::new(PoolErrorCode::ResetFailed, "checkout detach failed"))?;
    git(path, &["reset", "--hard", &base_oid], GIT_MUTATION_TIMEOUT)
        .await
        .map_err(|_| PoolError::new(PoolErrorCode::ResetFailed, "reset --hard failed"))?;
    git(path, &["clean", "-ffd"], GIT_MUTATION_TIMEOUT)
        .await
        .map_err(|_| PoolError::new(PoolErrorCode::ResetFailed, "git clean failed"))?;
    verify_tree_at_oid(path, &base_oid).await?;
    Ok((base_ref, base_oid))
}

/// What `snapshot_if_needed` pinned. `dirty_commit` is true when the tree's
/// uncommitted changes became the snapshot commit now at `HEAD`.
#[derive(Debug, Clone, Copy, Default)]
struct SnapshotOutcome {
    dirty_commit: bool,
}

async fn snapshot_if_needed(path: &Path, slot_id: &str) -> Result<SnapshotOutcome, PoolError> {
    let dirty = !status_porcelain_with_all_untracked(path, PoolErrorCode::Io)
        .await?
        .is_empty();
    // Fail-closed: any rev-list/parse error quarantines (never treat as 0).
    let unpushed_raw = git(
        path,
        &["rev-list", "--count", "HEAD", "--not", "--remotes"],
        GIT_LOCAL_TIMEOUT,
    )
    .await
    .map_err(|_| {
        PoolError::new(
            PoolErrorCode::SnapshotCommitFailed,
            "rev-list unpushed count failed",
        )
    })?;
    let unpushed_count: u64 = unpushed_raw.parse().map_err(|_| {
        PoolError::new(
            PoolErrorCode::SnapshotCommitFailed,
            "rev-list unpushed count unparseable",
        )
    })?;
    let unpushed = unpushed_count > 0;

    if !dirty && !unpushed {
        return Ok(SnapshotOutcome::default());
    }
    if dirty {
        git(path, &["add", "-A"], GIT_MUTATION_TIMEOUT)
            .await
            .map_err(|_| PoolError::new(PoolErrorCode::SnapshotCommitFailed, "git add failed"))?;
        reject_newly_staged_gitlinks(path).await?;
        git(
            path,
            &[
                "-c",
                "user.name=xmatrix-daemon",
                "-c",
                "user.email=daemon@xmatrix.local",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--quiet",
                "--no-verify",
                "-m",
                "xmatrix: repo pool snapshot before return",
            ],
            GIT_MUTATION_TIMEOUT,
        )
        .await
        .map_err(|_| {
            PoolError::new(
                PoolErrorCode::SnapshotCommitFailed,
                "snapshot commit failed",
            )
        })?;
    }
    // Unique hierarchical ref: refs/xmatrix/snapshot/<slotId>/<uuid>
    let unique = uuid::Uuid::new_v4().simple().to_string();
    let snapshot_ref = format!("refs/xmatrix/snapshot/{slot_id}/{unique}");
    git(
        path,
        &["update-ref", &snapshot_ref, "HEAD"],
        GIT_LOCAL_TIMEOUT,
    )
    .await
    .map_err(|_| {
        PoolError::new(
            PoolErrorCode::SnapshotRefFailed,
            "snapshot update-ref failed",
        )
    })?;
    Ok(SnapshotOutcome {
        dirty_commit: dirty,
    })
}

#[derive(Clone, Debug)]
struct ResolvedBase {
    base_ref: String,
    oid: String,
}

async fn fetched_for_pinned_base<'a>(
    fetched_repo: &Path,
    pinned_repo: &Path,
    fetched: &'a ResolvedBase,
) -> Result<std::borrow::Cow<'a, ResolvedBase>, PoolError> {
    if fetch_coordinator_key(fetched_repo) == fetch_coordinator_key(pinned_repo) {
        Ok(std::borrow::Cow::Borrowed(fetched))
    } else {
        required_fetch_and_resolve(pinned_repo)
            .await
            .map(std::borrow::Cow::Owned)
    }
}

#[derive(Clone)]
struct SharedFetchError {
    code: PoolErrorCode,
    message: String,
}

type SharedFetchResult = Result<ResolvedBase, SharedFetchError>;

struct InFlightFetch {
    result: StdMutex<Option<SharedFetchResult>>,
    done: tokio::sync::Notify,
}

struct FetchRepoState {
    cache: Option<(Instant, ResolvedBase)>,
    inflight: Option<Arc<InFlightFetch>>,
}

fn fetch_repo_states() -> &'static StdMutex<std::collections::HashMap<PathBuf, FetchRepoState>> {
    static STATES: OnceLock<StdMutex<std::collections::HashMap<PathBuf, FetchRepoState>>> =
        OnceLock::new();
    STATES.get_or_init(|| StdMutex::new(std::collections::HashMap::new()))
}

fn fetch_coordinator_key(base_repo: &Path) -> PathBuf {
    let abs = std::fs::canonicalize(base_repo).unwrap_or_else(|_| base_repo.to_path_buf());
    #[cfg(windows)]
    {
        PathBuf::from(abs.to_string_lossy().to_ascii_lowercase())
    }
    #[cfg(not(windows))]
    {
        abs
    }
}

#[cfg(test)]
fn invalidate_required_fetch_cache(base_repo: &Path) {
    let key = fetch_coordinator_key(base_repo);
    if let Ok(mut states) = fetch_repo_states().lock()
        && let Some(state) = states.get_mut(&key)
    {
        state.cache = None;
    }
}

#[cfg(test)]
fn take_required_fetch_perform_count(base_repo: &Path) -> u32 {
    let key = fetch_coordinator_key(base_repo);
    fetch_perform_counts()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(&key)
        .unwrap_or(0)
}

#[cfg(test)]
fn fetch_perform_counts() -> &'static StdMutex<std::collections::HashMap<PathBuf, u32>> {
    static COUNTS: OnceLock<StdMutex<std::collections::HashMap<PathBuf, u32>>> = OnceLock::new();
    COUNTS.get_or_init(|| StdMutex::new(std::collections::HashMap::new()))
}

enum FetchPlan {
    Cached(ResolvedBase),
    Join(Arc<InFlightFetch>),
    Lead(Arc<InFlightFetch>),
}

/// Repo-level required fetch: reuse a fresh snapshot, join an in-flight fetch,
/// or become the leader. Never holds the pool manifest lock.
async fn required_fetch_and_resolve(base_repo: &Path) -> Result<ResolvedBase, PoolError> {
    let key = fetch_coordinator_key(base_repo);
    loop {
        let plan = {
            let mut states = fetch_repo_states()
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let state = states.entry(key.clone()).or_insert(FetchRepoState {
                cache: None,
                inflight: None,
            });
            if let Some((at, resolved)) = &state.cache
                && at.elapsed() < REQUIRED_FETCH_CACHE_TTL
            {
                FetchPlan::Cached(resolved.clone())
            } else if let Some(inflight) = state.inflight.clone() {
                FetchPlan::Join(inflight)
            } else {
                let inflight = Arc::new(InFlightFetch {
                    result: StdMutex::new(None),
                    done: tokio::sync::Notify::new(),
                });
                state.inflight = Some(inflight.clone());
                FetchPlan::Lead(inflight)
            }
        };
        match plan {
            FetchPlan::Cached(resolved) => return Ok(resolved),
            FetchPlan::Lead(inflight) => {
                let outcome = perform_required_fetch_and_resolve(base_repo).await;
                let shared = match &outcome {
                    Ok(resolved) => Ok(resolved.clone()),
                    Err(error) => Err(SharedFetchError {
                        code: error.code,
                        message: error.message.clone(),
                    }),
                };
                {
                    let mut states = fetch_repo_states()
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    if let Some(state) = states.get_mut(&key) {
                        state.inflight = None;
                        if let Ok(resolved) = &shared {
                            state.cache = Some((Instant::now(), resolved.clone()));
                        }
                    }
                }
                if let Ok(mut slot) = inflight.result.lock() {
                    *slot = Some(shared);
                }
                inflight.done.notify_waiters();
                return outcome;
            }
            FetchPlan::Join(inflight) => {
                let notified = inflight.done.notified();
                if let Ok(slot) = inflight.result.lock()
                    && let Some(shared) = slot.clone()
                {
                    return shared_fetch_result(shared);
                }
                notified.await;
                if let Ok(slot) = inflight.result.lock()
                    && let Some(shared) = slot.clone()
                {
                    return shared_fetch_result(shared);
                }
            }
        }
    }
}

fn shared_fetch_result(shared: SharedFetchResult) -> Result<ResolvedBase, PoolError> {
    shared.map_err(|error| PoolError::new(error.code, error.message))
}

/// Required fetch first, then resolve remote default. No HEAD fallback.
async fn perform_required_fetch_and_resolve(base_repo: &Path) -> Result<ResolvedBase, PoolError> {
    #[cfg(test)]
    {
        let key = fetch_coordinator_key(base_repo);
        *fetch_perform_counts()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .entry(key)
            .or_insert(0) += 1;
    }
    required_origin_fetch(base_repo).await?;

    let _ = git(
        base_repo,
        &["remote", "set-head", "origin", "--auto"],
        GIT_FETCH_TIMEOUT,
    )
    .await;

    let base_ref = if let Ok(branch) = git(
        base_repo,
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
        branch
    } else {
        let mut found = None;
        for candidate in ["origin/main", "origin/master"] {
            if git(
                base_repo,
                &["rev-parse", "--verify", "--quiet", candidate],
                GIT_LOCAL_TIMEOUT,
            )
            .await
            .is_ok()
            {
                found = Some(candidate.to_string());
                break;
            }
        }
        found.ok_or_else(|| {
            PoolError::new(
                PoolErrorCode::BaseRefUnresolved,
                "could not resolve origin default branch after fetch",
            )
        })?
    };

    let oid = git(
        base_repo,
        &["rev-parse", "--verify", &base_ref],
        GIT_LOCAL_TIMEOUT,
    )
    .await
    .map_err(|_| {
        PoolError::new(
            PoolErrorCode::BaseRefUnresolved,
            "could not resolve base oid",
        )
    })?;
    Ok(ResolvedBase { base_ref, oid })
}

/// `git fetch` on a pool base can lose a lock or a brief network blip,
/// especially when the checkout already has many linked worktrees. Fetch
/// only the default branch — a full `origin` download races every other
/// remote-tracking lock on a busy Workstation checkout — and retry instead
/// of failing the whole :new lease.
async fn required_origin_fetch(base_repo: &Path) -> Result<(), PoolError> {
    let spec = origin_default_fetch_spec(base_repo).await;
    let mut last_error = GitRunError::Failed;
    for attempt in 1..=GIT_FETCH_ATTEMPTS {
        let result = match spec.as_deref() {
            Some(branch) => {
                let refspec = format!("refs/heads/{branch}:refs/remotes/origin/{branch}");
                git(
                    base_repo,
                    &["fetch", "--quiet", "--no-tags", "origin", &refspec],
                    GIT_FETCH_TIMEOUT,
                )
                .await
            }
            None => {
                git(
                    base_repo,
                    &["fetch", "--quiet", "--no-tags", "origin"],
                    GIT_FETCH_TIMEOUT,
                )
                .await
            }
        };
        match result {
            Ok(_) => return Ok(()),
            Err(error) => last_error = error,
        }
        // A refused credential or a missing repository does not change on retry.
        if matches!(last_error, GitRunError::Auth | GitRunError::NotFound) {
            break;
        }
        if attempt < GIT_FETCH_ATTEMPTS {
            // A lock clears in moments; an unreachable remote needs longer.
            let step_ms = if matches!(last_error, GitRunError::Network | GitRunError::Timeout) {
                3_000
            } else {
                400
            };
            tokio::time::sleep(Duration::from_millis(step_ms * u64::from(attempt))).await;
        }
    }
    Err(required_fetch_error(last_error, space_scoped_git_capability()))
}

/// Under the Space's GitHub grant, GitHub refusing the fetch is that
/// connection's answer about the repository: the message carries the stable
/// `repository_access_unavailable` code the Hub shows for it. The persisted
/// pool code stays `fetch_required_failed`, which every daemon version reads.
/// With the host's own credentials it stays an ordinary fetch failure.
fn required_fetch_error(error: GitRunError, space_scoped: bool) -> PoolError {
    if space_scoped && matches!(error, GitRunError::Auth | GitRunError::NotFound) {
        return PoolError::new(
            PoolErrorCode::FetchRequiredFailed,
            format!(
                "repository_access_unavailable: GitHub refused the Space's credential ({})",
                error.as_str()
            ),
        );
    }
    PoolError::new(
        PoolErrorCode::FetchRequiredFailed,
        format!("required origin fetch failed ({})", error.as_str()),
    )
}

/// Prefer an already-known `origin/HEAD`, else one `ls-remote --symref`.
/// The returned name is only used as a fetch refspec, never interpolated
/// into a shell.
async fn origin_default_fetch_spec(base_repo: &Path) -> Option<String> {
    if let Ok(symbolic) = git(
        base_repo,
        &[
            "symbolic-ref",
            "--quiet",
            "--short",
            "refs/remotes/origin/HEAD",
        ],
        GIT_LOCAL_TIMEOUT,
    )
    .await
        && let Some(branch) = symbolic.strip_prefix("origin/") {
            let branch = branch.trim();
            if is_safe_fetch_branch(branch) {
                return Some(branch.to_string());
            }
        }
    let output = git(
        base_repo,
        &["ls-remote", "--symref", "origin", "HEAD"],
        GIT_FETCH_TIMEOUT,
    )
    .await
    .ok()?;
    parse_ls_remote_head_branch(&output)
}

fn parse_ls_remote_head_branch(output: &str) -> Option<String> {
    for line in output.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("ref:") else {
            continue;
        };
        let name = rest.split(['\t', ' ']).find(|part| {
            let part = part.trim();
            !part.is_empty() && part != "HEAD"
        })?;
        let branch = name.trim().strip_prefix("refs/heads/")?;
        if is_safe_fetch_branch(branch) {
            return Some(branch.to_string());
        }
    }
    None
}

fn is_safe_fetch_branch(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('-')
        && !name.contains("..")
        && !name.contains('\\')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '-' | '.'))
}

async fn verify_tree_at_oid(path: &Path, expected_oid: &str) -> Result<(), PoolError> {
    let head = git(path, &["rev-parse", "HEAD"], GIT_LOCAL_TIMEOUT)
        .await
        .map_err(|_| PoolError::new(PoolErrorCode::VerifyFailed, "rev-parse HEAD failed"))?;
    if head != expected_oid {
        return Err(PoolError::new(
            PoolErrorCode::VerifyFailed,
            "HEAD does not equal fetched base oid",
        ));
    }
    // Detached: symbolic-ref should fail.
    if git(path, &["symbolic-ref", "-q", "HEAD"], GIT_LOCAL_TIMEOUT)
        .await
        .is_ok()
    {
        return Err(PoolError::new(
            PoolErrorCode::VerifyFailed,
            "HEAD is not detached",
        ));
    }
    let porcelain = status_porcelain_with_all_untracked(path, PoolErrorCode::VerifyFailed).await?;
    if !porcelain.is_empty() {
        return Err(PoolError::new(
            PoolErrorCode::VerifyFailed,
            "non-ignored worktree delta remains after reset/clean",
        ));
    }
    Ok(())
}

/// Never let repository-local `status.showUntrackedFiles=no` hide bytes that
/// the return path is about to delete. The explicit command-line override is
/// authoritative for both snapshot detection and post-clean verification.
async fn status_porcelain_with_all_untracked(
    path: &Path,
    error_code: PoolErrorCode,
) -> Result<String, PoolError> {
    git(
        path,
        &[
            "-c",
            "status.showUntrackedFiles=all",
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
        ],
        GIT_LOCAL_TIMEOUT,
    )
    .await
    .map_err(|_| PoolError::new(error_code, "status with all untracked files failed"))
}

/// `git add -A` records an untracked nested repository as a mode-160000
/// gitlink, not the nested repository's worktree contents. A later clean would
/// therefore destroy nested WIP that the snapshot did not preserve. Fail
/// closed before commit/reset so the exact tree remains available in the
/// quarantined slot.
async fn reject_newly_staged_gitlinks(path: &Path) -> Result<(), PoolError> {
    let raw = git(
        path,
        &[
            "diff",
            "--cached",
            "--diff-filter=A",
            "--raw",
            "--no-abbrev",
            "-z",
        ],
        GIT_LOCAL_TIMEOUT,
    )
    .await
    .map_err(|_| {
        PoolError::new(
            PoolErrorCode::SnapshotCommitFailed,
            "staged entry inspection failed",
        )
    })?;
    if raw
        .split('\0')
        .any(|record| record.starts_with(":000000 160000 "))
    {
        return Err(PoolError::new(
            PoolErrorCode::SnapshotCommitFailed,
            "untracked nested repository cannot be snapshotted losslessly",
        ));
    }
    Ok(())
}

async fn verify_base_matches_identity(
    base_repo: &Path,
    identity: &CanonicalRepoIdentity,
) -> Result<(), PoolError> {
    // Use config --get (not `remote get-url`) so insteadOf rewrites used for
    // local fixture fetch do not change the stored identity URL.
    let origin = git(
        base_repo,
        &["config", "--get", "remote.origin.url"],
        GIT_LOCAL_TIMEOUT,
    )
    .await
    .map_err(|_| PoolError::new(PoolErrorCode::RemoteMismatch, "base has no origin remote"))?;
    // Canonicalization parses URL authority and discards userinfo/query/fragment.
    let origin_identity = canonical_repo_identity(&origin)?;
    if origin_identity.as_str() != identity.as_str() {
        return Err(PoolError::new(
            PoolErrorCode::RemoteMismatch,
            "base remote identity does not match pool",
        ));
    }
    Ok(())
}

async fn verify_worktree_belongs_to_base(
    base_repo: &Path,
    worktree: &Path,
) -> Result<(), PoolError> {
    if !worktree.join(".git").is_file() {
        return Err(PoolError::new(
            PoolErrorCode::WorktreeMissing,
            "slot is not a linked git worktree",
        ));
    }
    let _admin = resolve_validated_worktree_admin(base_repo, worktree).await?;
    Ok(())
}

/// Shared ownership entry: common-dir match + admin dir under
/// `<base-common>/worktrees/<name>` with no reparse escape.
async fn resolve_validated_worktree_admin(
    base_repo: &Path,
    worktree: &Path,
) -> Result<PathBuf, PoolError> {
    let admin_pointer = read_linked_worktree_admin_pointer(worktree)?;
    let base_common = git(
        base_repo,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        GIT_LOCAL_TIMEOUT,
    )
    .await
    .map_err(|_| PoolError::new(PoolErrorCode::VerifyFailed, "base common-dir failed"))?;
    let tree_common = git(
        worktree,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        GIT_LOCAL_TIMEOUT,
    )
    .await
    .map_err(|_| PoolError::new(PoolErrorCode::VerifyFailed, "slot common-dir failed"))?;
    let base_c = strip_extended_length_prefix(
        std::fs::canonicalize(PathBuf::from(base_common.trim())).map_err(|_| {
            PoolError::new(
                PoolErrorCode::VerifyFailed,
                "canonicalize base common-dir failed",
            )
        })?,
    );
    let tree_c = strip_extended_length_prefix(
        std::fs::canonicalize(PathBuf::from(tree_common.trim())).map_err(|_| {
            PoolError::new(
                PoolErrorCode::VerifyFailed,
                "canonicalize slot common-dir failed",
            )
        })?,
    );
    if base_c != tree_c {
        return Err(PoolError::new(
            PoolErrorCode::VerifyFailed,
            "slot git common-dir does not belong to pool base",
        ));
    }

    let admin_raw = git(
        worktree,
        &["rev-parse", "--absolute-git-dir"],
        GIT_LOCAL_TIMEOUT,
    )
    .await
    .map_err(|_| {
        PoolError::new(
            PoolErrorCode::VerifyFailed,
            "resolve worktree admin dir failed",
        )
    })?;
    let admin_path = PathBuf::from(admin_raw.trim());
    reject_path_components(&admin_path)?;

    // Trusted boundary: only refuse reparse at/under common-dir/worktrees.
    // Do NOT walk from filesystem root (would false-reject macOS /tmp,/var, symlink homes).
    let worktrees_root = base_c.join("worktrees");
    if !worktrees_root.is_dir() {
        return Err(PoolError::new(
            PoolErrorCode::VerifyFailed,
            "base worktrees admin root missing",
        ));
    }
    // worktrees component itself must not be a reparse (within base common-dir).
    reject_reparse(&worktrees_root)?;
    let worktrees_c =
        strip_extended_length_prefix(std::fs::canonicalize(&worktrees_root).map_err(|_| {
            PoolError::new(
                PoolErrorCode::VerifyFailed,
                "canonicalize base worktrees root failed",
            )
        })?);

    // Git canonicalizes `--absolute-git-dir`, so inspect the raw pointer leaf
    // from the linked worktree's `.git` file before following it. Symlinks in
    // parents above the trusted boundary remain valid; a symlink admin leaf is
    // not.
    let pointer_meta = std::fs::symlink_metadata(&admin_pointer).map_err(|_| {
        PoolError::new(
            PoolErrorCode::VerifyFailed,
            "stat worktree admin pointer failed",
        )
    })?;
    if pointer_meta.file_type().is_symlink() {
        return Err(PoolError::new(
            PoolErrorCode::PathEscape,
            "worktree admin dir is a symlink",
        ));
    }
    reject_reparse(&admin_pointer)?;

    let git_admin_c =
        strip_extended_length_prefix(std::fs::canonicalize(&admin_path).map_err(|_| {
            PoolError::new(
                PoolErrorCode::VerifyFailed,
                "canonicalize worktree admin dir failed",
            )
        })?);
    let admin_c =
        strip_extended_length_prefix(std::fs::canonicalize(&admin_pointer).map_err(|_| {
            PoolError::new(
                PoolErrorCode::VerifyFailed,
                "canonicalize worktree admin pointer failed",
            )
        })?);
    if !paths_equal_platform(&git_admin_c, &admin_c) {
        return Err(PoolError::new(
            PoolErrorCode::VerifyFailed,
            "worktree admin pointer disagrees with git",
        ));
    }

    // Admin must live under common-dir/worktrees/<admin-name>.
    if !path_is_within(&worktrees_c, &admin_c) {
        return Err(PoolError::new(
            PoolErrorCode::PathEscape,
            "worktree admin dir escaped base worktrees root",
        ));
    }
    // Direct child of worktrees/ only (not nested escape paths).
    let parent = admin_c.parent().ok_or_else(|| {
        PoolError::new(
            PoolErrorCode::VerifyFailed,
            "worktree admin dir has no parent",
        )
    })?;
    let parent_c = strip_extended_length_prefix(parent.to_path_buf());
    if !paths_equal_platform(&parent_c, &worktrees_c) {
        return Err(PoolError::new(
            PoolErrorCode::VerifyFailed,
            "worktree admin dir is not a direct worktrees child",
        ));
    }
    // Re-check resolved admin within boundary (no reparse at leaf).
    reject_reparse(&admin_c)?;
    Ok(admin_c)
}

fn read_linked_worktree_admin_pointer(worktree: &Path) -> Result<PathBuf, PoolError> {
    let git_file = worktree.join(".git");
    let meta = std::fs::symlink_metadata(&git_file).map_err(|_| {
        PoolError::new(
            PoolErrorCode::WorktreeMissing,
            "linked worktree .git file missing",
        )
    })?;
    ensure_regular_file_no_reparse(&git_file, &meta)?;
    if meta.len() > MAX_GITDIR_POINTER_BYTES {
        return Err(PoolError::new(
            PoolErrorCode::VerifyFailed,
            "linked worktree .git file exceeds size limit",
        ));
    }

    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(&git_file).map_err(|_| {
        PoolError::new(
            PoolErrorCode::VerifyFailed,
            "open linked worktree .git file failed",
        )
    })?;
    let mut raw = Vec::new();
    file.take(MAX_GITDIR_POINTER_BYTES + 1)
        .read_to_end(&mut raw)
        .map_err(|_| {
            PoolError::new(
                PoolErrorCode::VerifyFailed,
                "read linked worktree .git file failed",
            )
        })?;
    if raw.len() as u64 > MAX_GITDIR_POINTER_BYTES {
        return Err(PoolError::new(
            PoolErrorCode::VerifyFailed,
            "linked worktree .git file exceeds size limit",
        ));
    }
    let text = std::str::from_utf8(&raw).map_err(|_| {
        PoolError::new(
            PoolErrorCode::VerifyFailed,
            "linked worktree .git file is not utf-8",
        )
    })?;
    let line = text.trim_end_matches(['\r', '\n']);
    if line.contains(['\r', '\n']) {
        return Err(PoolError::new(
            PoolErrorCode::VerifyFailed,
            "linked worktree .git file has extra lines",
        ));
    }
    let value = line.strip_prefix("gitdir: ").ok_or_else(|| {
        PoolError::new(
            PoolErrorCode::VerifyFailed,
            "linked worktree .git pointer invalid",
        )
    })?;
    if value.is_empty() || value.chars().any(char::is_control) {
        return Err(PoolError::new(
            PoolErrorCode::VerifyFailed,
            "linked worktree .git pointer invalid",
        ));
    }
    let path = PathBuf::from(value);
    let path = if path.is_absolute() {
        path
    } else {
        worktree.join(path)
    };
    reject_path_components(&path)?;
    Ok(path)
}

// --- path safety ---

/// Strip Windows extended-length prefixes without corrupting UNC roots.
/// Delegates to the workspace-shared helper: `\\?\UNC\server\share` →
/// `\\server\share`, `\\?\C:\...` → `C:\...`.
fn strip_extended_length_prefix(path: PathBuf) -> PathBuf {
    let s = path.to_string_lossy();
    PathBuf::from(xmatrix_cli_workspace::normalize_workspace_path_string_for_storage(&s))
}

fn reject_path_components(path: &Path) -> Result<(), PoolError> {
    for component in path.components() {
        match component {
            Component::ParentDir => {
                return Err(PoolError::new(
                    PoolErrorCode::PathEscape,
                    "path contains ..",
                ));
            }
            Component::Normal(name) => {
                let name = name.to_string_lossy();
                if name.contains('\0') || name == ".." {
                    return Err(PoolError::new(
                        PoolErrorCode::PathEscape,
                        "illegal path component",
                    ));
                }
            }
            _ => {}
        }
    }
    Ok(())
}

// Called under the pool mutation coordinator. Reserve against both durable slot
// records (including missing/quarantined trees) and unrecorded on-disk entries.
fn allocate_slot_id(
    layout: &RepoPoolLayout,
    manifest: &RepoPoolManifest,
    mut generate: impl FnMut() -> SlotId,
) -> Result<SlotId, PoolError> {
    // A reclaimed resting session keeps its path reserved for its rehydrate.
    let reserved = load_rehydrate_records(layout).unwrap_or_default();
    for _ in 0..32 {
        let id = generate();
        let component = layout.slot_component(&id);
        let same_path = |key: &str| {
            if layout.is_compact() {
                &key[..SLOT_DIR_CHARS] == component
            } else {
                key == component
            }
        };
        let occupied = manifest.slots.keys().any(|key| same_path(key))
            || reserved.iter().any(|record| same_path(&record.slot_id));
        if occupied {
            continue;
        }
        let path = layout.slots_root().join(component);
        match std::fs::symlink_metadata(&path) {
            Ok(_) => continue,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(id),
            Err(_) => {
                return Err(PoolError::new(
                    PoolErrorCode::Io,
                    "inspect slot allocation failed",
                ));
            }
        }
    }
    Err(PoolError::new(
        PoolErrorCode::WorktreeCreateFailed,
        "slot name allocation exhausted",
    ))
}

/// Containment relative to a **trusted** pools root only (not filesystem root).
/// Callers must pass a layout whose trusted root was already fixed/canonicalized.
fn ensure_path_inside_layout(layout: &RepoPoolLayout, candidate: &Path) -> Result<(), PoolError> {
    reject_path_components(candidate)?;
    let slot_name = candidate
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| PoolError::new(PoolErrorCode::PathEscape, "invalid slot path"))?;
    let expected_len = if layout.is_compact() {
        SLOT_DIR_CHARS
    } else {
        32
    };
    if slot_name.len() != expected_len
        || !slot_name
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(PoolError::new(
            PoolErrorCode::PathEscape,
            "invalid slot directory name",
        ));
    }
    let expected = layout.slots_root().join(slot_name);
    if !paths_equal_platform(candidate, &expected) {
        return Err(PoolError::new(
            PoolErrorCode::PathEscape,
            "slot path does not match pool layout",
        ));
    }

    let trusted = layout.trusted_pools_root();
    // Only inspect components under the trusted root (owner/repo/slots/...).
    reject_reparse_under_root(trusted, layout.pool_root())?;
    reject_reparse_under_root(trusted, candidate)?;

    if layout.pool_root().exists() {
        let root_canon = std::fs::canonicalize(layout.pool_root()).map_err(|_| {
            PoolError::new(PoolErrorCode::PathEscape, "canonicalize pool root failed")
        })?;
        // Must still be under trusted root.
        let trusted_canon = if trusted.exists() {
            std::fs::canonicalize(trusted).map_err(|_| {
                PoolError::new(
                    PoolErrorCode::PathEscape,
                    "canonicalize trusted root failed",
                )
            })?
        } else {
            trusted.to_path_buf()
        };
        if !path_is_within(&trusted_canon, &root_canon) && root_canon != trusted_canon {
            return Err(PoolError::new(
                PoolErrorCode::PathEscape,
                "pool root escaped trusted root",
            ));
        }
        if candidate.exists() {
            let cand_canon = std::fs::canonicalize(candidate).map_err(|_| {
                PoolError::new(PoolErrorCode::PathEscape, "canonicalize candidate failed")
            })?;
            if !path_is_within(&root_canon, &cand_canon) {
                return Err(PoolError::new(
                    PoolErrorCode::PathEscape,
                    "slot path escapes pool root",
                ));
            }
        }
    } else if candidate.exists() {
        return Err(PoolError::new(
            PoolErrorCode::PathEscape,
            "slot exists but pool root is missing",
        ));
    }
    Ok(())
}

/// Walk path components, but only apply reparse checks once under `trusted`.
fn reject_reparse_under_root(trusted: &Path, path: &Path) -> Result<(), PoolError> {
    let trusted_components: Vec<_> = trusted.components().collect();
    let path_components: Vec<_> = path.components().collect();
    if path_components.len() < trusted_components.len() {
        return Ok(());
    }
    // Prefix must match trusted (platform equality).
    let mut cursor = PathBuf::new();
    for (i, component) in path_components.iter().enumerate() {
        cursor.push(*component);
        if i < trusted_components.len() {
            continue; // above/at trusted boundary: do not reject legitimate home symlinks
        }
        if cursor.exists() {
            reject_reparse(&cursor)?;
        }
    }
    Ok(())
}

fn path_is_within(root: &Path, candidate: &Path) -> bool {
    let mut c = candidate;
    loop {
        if c == root {
            return true;
        }
        match c.parent() {
            Some(p) if p != c => c = p,
            _ => return false,
        }
    }
}

fn paths_equal_platform(a: &Path, b: &Path) -> bool {
    #[cfg(windows)]
    {
        a.to_string_lossy()
            .replace('\\', "/")
            .eq_ignore_ascii_case(&b.to_string_lossy().replace('\\', "/"))
    }
    #[cfg(not(windows))]
    {
        a == b
    }
}

fn reject_reparse(path: &Path) -> Result<(), PoolError> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        let meta = std::fs::symlink_metadata(path)
            .map_err(|_| PoolError::new(PoolErrorCode::PathEscape, "metadata failed"))?;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(PoolError::new(
                PoolErrorCode::PathEscape,
                "refusing reparse/junction/symlink",
            ));
        }
    }
    #[cfg(not(windows))]
    {
        let meta = std::fs::symlink_metadata(path)
            .map_err(|_| PoolError::new(PoolErrorCode::PathEscape, "metadata failed"))?;
        if meta.file_type().is_symlink() {
            return Err(PoolError::new(
                PoolErrorCode::PathEscape,
                "refusing symlink",
            ));
        }
    }
    Ok(())
}

// --- lock / atomic ---

#[derive(Debug)]
struct PoolGuard {
    _process_guard: tokio::sync::OwnedMutexGuard<()>,
}

pub(crate) type PathCoordinators =
    std::sync::Mutex<std::collections::HashMap<PathBuf, std::sync::Weak<tokio::sync::Mutex<()>>>>;

// A weak registry forgets inactive paths without dropping a live coordinator.
pub(crate) fn path_coordinator(
    registry: &PathCoordinators,
    path: &Path,
) -> std::sync::Arc<tokio::sync::Mutex<()>> {
    let mut coordinators = registry
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    coordinators.retain(|_, coordinator| coordinator.strong_count() > 0);
    if let Some(coordinator) = coordinators.get(path).and_then(std::sync::Weak::upgrade) {
        return coordinator;
    }
    let coordinator = std::sync::Arc::new(tokio::sync::Mutex::new(()));
    coordinators.insert(path.to_path_buf(), std::sync::Arc::downgrade(&coordinator));
    coordinator
}

fn process_pool_coordinator(pool_root: &Path) -> std::sync::Arc<tokio::sync::Mutex<()>> {
    static COORDINATORS: std::sync::OnceLock<PathCoordinators> = std::sync::OnceLock::new();
    path_coordinator(COORDINATORS.get_or_init(Default::default), pool_root)
}

/// Serialize all pool authority changes inside the one machine daemon. Hub
/// command claims guarantee one daemon route; this keyed coordinator orders
/// different Runs for the same repository without creating filesystem lock
/// authority that can outlive or disagree with the daemon.
async fn acquire_pool_guard(layout: &RepoPoolLayout) -> Result<PoolGuard, PoolError> {
    layout.revalidate_on_disk()?;
    let pool_root = layout.pool_root().to_path_buf();
    if !pool_root.is_dir() {
        return Err(PoolError::new(
            PoolErrorCode::PathEscape,
            "pool root missing or not a directory at mutation time",
        ));
    }
    let process_guard = process_pool_coordinator(&pool_root).lock_owned().await;
    // Revalidate after the wait because an earlier operation may have changed
    // the on-disk pool layout.
    layout.revalidate_on_disk()?;
    Ok(PoolGuard {
        _process_guard: process_guard,
    })
}

// --- worktree ownership / lock ---

fn pool_worktree_lock_reason(layout: &RepoPoolLayout, slot_id: &SlotId) -> String {
    format!(
        "{WORKTREE_LOCK_REASON_PREFIX}{}/{}",
        layout.repo_key().as_str(),
        slot_id.as_str()
    )
}

fn parse_pool_worktree_lock_reason(reason: &str) -> Option<(&str, &str)> {
    let rest = reason.strip_prefix(WORKTREE_LOCK_REASON_PREFIX)?;
    let mut parts = rest.split('/');
    let repo = parts.next()?;
    let slot = parts.next()?;
    if parts.next().is_some() || repo.is_empty() || slot.is_empty() {
        return None;
    }
    Some((repo, slot))
}

async fn read_worktree_lock_reason(
    base_repo: &Path,
    worktree: &Path,
) -> Result<Option<String>, PoolError> {
    let admin_dir = resolve_validated_worktree_admin(base_repo, worktree).await?;
    let locked = admin_dir.join("locked");
    if !locked.exists() {
        return Ok(None);
    }
    // locked must be a regular non-reparse file with bounded size.
    reject_reparse(&locked)?;
    let meta = std::fs::symlink_metadata(&locked)
        .map_err(|_| PoolError::new(PoolErrorCode::Io, "locked file metadata failed"))?;
    if !meta.file_type().is_file() {
        return Err(PoolError::new(
            PoolErrorCode::VerifyFailed,
            "worktree locked path is not a regular file",
        ));
    }
    if meta.len() > MAX_LOCK_REASON_BYTES {
        return Err(PoolError::new(
            PoolErrorCode::VerifyFailed,
            "worktree lock reason exceeds size limit",
        ));
    }
    let mut file = File::open(&locked)
        .map_err(|_| PoolError::new(PoolErrorCode::Io, "open worktree lock reason failed"))?;
    let mut buf = vec![0u8; (MAX_LOCK_REASON_BYTES as usize) + 1];
    use std::io::Read;
    let n = file
        .read(&mut buf)
        .map_err(|_| PoolError::new(PoolErrorCode::Io, "read worktree lock reason failed"))?;
    if n as u64 > MAX_LOCK_REASON_BYTES {
        return Err(PoolError::new(
            PoolErrorCode::VerifyFailed,
            "worktree lock reason exceeds size limit",
        ));
    }
    let reason = String::from_utf8_lossy(&buf[..n]).trim().to_string();
    Ok(Some(reason))
}

async fn lock_pool_worktree(
    base_repo: &Path,
    worktree: &Path,
    layout: &RepoPoolLayout,
    slot_id: &SlotId,
) -> Result<(), PoolError> {
    let path_arg = worktree.display().to_string();
    let reason = pool_worktree_lock_reason(layout, slot_id);
    git(
        base_repo,
        &["worktree", "lock", "--reason", &reason, &path_arg],
        GIT_LOCAL_TIMEOUT,
    )
    .await
    .map_err(|error| {
        PoolError::new(
            PoolErrorCode::WorktreeLockFailed,
            format!("git worktree lock failed ({})", error.as_str()),
        )
    })?;
    let got = read_worktree_lock_reason(base_repo, worktree)
        .await?
        .ok_or_else(|| {
            PoolError::new(
                PoolErrorCode::WorktreeLockFailed,
                "worktree lock missing after lock",
            )
        })?;
    if got != reason {
        return Err(PoolError::new(
            PoolErrorCode::WorktreeLockFailed,
            "worktree lock reason mismatch after lock",
        ));
    }
    Ok(())
}

/// Containment + common-dir + admin under worktrees/ + exact expected pool lock.
async fn verify_pool_worktree_ownership(
    layout: &RepoPoolLayout,
    base_repo: &Path,
    worktree: &Path,
    slot_id: &SlotId,
) -> Result<(), PoolError> {
    ensure_path_inside_layout(layout, worktree)?;
    // Admin validation is shared with belongs-to-base / lock-read / cleanup.
    let _admin = resolve_validated_worktree_admin(base_repo, worktree).await?;
    let expected = pool_worktree_lock_reason(layout, slot_id);
    match read_worktree_lock_reason(base_repo, worktree).await? {
        Some(reason) if reason == expected => {
            // Parse defensively so foreign-looking tags cannot pass equality edge cases.
            let Some((repo, slot)) = parse_pool_worktree_lock_reason(&reason) else {
                return Err(PoolError::new(
                    PoolErrorCode::ForeignWorktreeLock,
                    "worktree lock reason not pool-owned",
                ));
            };
            if repo != layout.repo_key().as_str() || slot != slot_id.as_str() {
                return Err(PoolError::new(
                    PoolErrorCode::ForeignWorktreeLock,
                    "worktree lock identity mismatch",
                ));
            }
            Ok(())
        }
        Some(_) => Err(PoolError::new(
            PoolErrorCode::ForeignWorktreeLock,
            "foreign worktree lock reason",
        )),
        None => Err(PoolError::new(
            PoolErrorCode::ForeignWorktreeLock,
            "missing pool worktree lock",
        )),
    }
}

async fn registered_base_repo_for_worktree(worktree: &Path) -> Result<PathBuf, PoolError> {
    let common = git(
        worktree,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        GIT_LOCAL_TIMEOUT,
    )
    .await
    .map_err(|_| {
        PoolError::new(
            PoolErrorCode::ManifestMismatch,
            "worktree common-dir could not be resolved",
        )
    })?;
    let common = std::fs::canonicalize(common).map_err(|_| {
        PoolError::new(
            PoolErrorCode::ManifestMismatch,
            "worktree common-dir could not be canonicalized",
        )
    })?;
    let common = strip_extended_length_prefix(common);
    if common.file_name().and_then(|value| value.to_str()) != Some(".git") {
        return Err(PoolError::new(
            PoolErrorCode::ManifestMismatch,
            "pool worktree common-dir is not a checkout .git directory",
        ));
    }
    let base_repo = common.parent().ok_or_else(|| {
        PoolError::new(
            PoolErrorCode::ManifestMismatch,
            "pool worktree common-dir has no checkout parent",
        )
    })?;
    if !base_repo.is_dir() {
        return Err(PoolError::new(
            PoolErrorCode::ManifestMismatch,
            "pool worktree base checkout is missing",
        ));
    }
    Ok(base_repo.to_path_buf())
}

/// Product-owned leftover at `poolRoot/slots/<slotId>` that is not a formal
/// linked worktree (`.git` pointer missing or the directory is already gone).
/// Layout containment and a non-symlink slot directory are required before
/// any recursive delete. `git worktree prune` drops the stale registration.
async fn remove_leftover_idle_slot_directory(
    layout: &RepoPoolLayout,
    base_repo: &Path,
    worktree: &Path,
) -> Result<(), PoolError> {
    ensure_path_inside_layout(layout, worktree)?;
    let _ = git(base_repo, &["worktree", "prune"], GIT_LOCAL_TIMEOUT).await;
    if !worktree.exists() {
        return Ok(());
    }
    let meta = std::fs::symlink_metadata(worktree)
        .map_err(|_| PoolError::new(PoolErrorCode::Io, "stat leftover idle slot failed"))?;
    if meta.file_type().is_symlink() {
        return Err(PoolError::new(
            PoolErrorCode::PathEscape,
            "refusing leftover slot that is a symlink",
        ));
    }
    if !meta.is_dir() {
        return Err(PoolError::new(
            PoolErrorCode::PathEscape,
            "leftover slot path is not a directory",
        ));
    }
    reject_reparse(worktree)?;
    if worktree.join(".git").is_file() {
        return Err(PoolError::new(
            PoolErrorCode::WorktreeCleanupFailed,
            "refusing leftover delete of a formal linked worktree",
        ));
    }
    std::fs::remove_dir_all(worktree).map_err(|_| {
        PoolError::new(
            PoolErrorCode::WorktreeCleanupFailed,
            "failed to remove leftover idle slot directory",
        )
    })
}

/// Safe cleanup for a tree created in this operation. Never `remove_dir_all`.
/// Requires layout containment + common-dir + validated admin. Unlocks only our
/// reason; foreign lock → fail-closed without unlock/remove.
/// On remove failure after unlock: re-apply exact owned lock (fail-closed if relock fails).
async fn try_safe_remove_created_worktree(
    layout: &RepoPoolLayout,
    base_repo: &Path,
    worktree: &Path,
    slot_id: &SlotId,
) -> Result<(), PoolError> {
    if !worktree.exists() {
        return Ok(());
    }
    ensure_path_inside_layout(layout, worktree)?;
    if worktree.join(".git").is_file() {
        let _admin = resolve_validated_worktree_admin(base_repo, worktree).await?;
        let expected = pool_worktree_lock_reason(layout, slot_id);
        let mut unlocked_owned = false;
        if let Some(reason) = read_worktree_lock_reason(base_repo, worktree).await? {
            if reason != expected {
                return Err(PoolError::new(
                    PoolErrorCode::ForeignWorktreeLock,
                    "refusing cleanup under foreign worktree lock",
                ));
            }
            #[cfg(test)]
            if TEST_FAIL_WORKTREE_UNLOCK.with(|c| c.get()) {
                return Err(PoolError::new(
                    PoolErrorCode::WorktreeCleanupFailed,
                    "injected worktree unlock failure",
                ));
            }
            let path_arg = worktree.display().to_string();
            git(
                base_repo,
                &["worktree", "unlock", &path_arg],
                GIT_LOCAL_TIMEOUT,
            )
            .await
            .map_err(|_| {
                PoolError::new(
                    PoolErrorCode::WorktreeCleanupFailed,
                    "git worktree unlock failed",
                )
            })?;
            unlocked_owned = true;
        }
        #[cfg(test)]
        if TEST_FAIL_WORKTREE_REMOVE.with(|c| c.get()) {
            if unlocked_owned {
                // Restore exact owned lock so we never leave unlocked Leased/orphan.
                lock_pool_worktree(base_repo, worktree, layout, slot_id).await?;
            }
            return Err(PoolError::new(
                PoolErrorCode::WorktreeCleanupFailed,
                "injected worktree remove failure",
            ));
        }
        let path_arg = worktree.display().to_string();
        if git(
            base_repo,
            &["worktree", "remove", "--force", &path_arg],
            GIT_MUTATION_TIMEOUT,
        )
        .await
        .is_err()
        {
            if unlocked_owned {
                // Remove failed after unlock: restore owned lock (fail-closed if cannot).
                lock_pool_worktree(base_repo, worktree, layout, slot_id)
                    .await
                    .map_err(|_| {
                        PoolError::new(
                            PoolErrorCode::WorktreeCleanupFailed,
                            "worktree remove failed and owned lock restore failed",
                        )
                    })?;
            }
            return Err(PoolError::new(
                PoolErrorCode::WorktreeCleanupFailed,
                "git worktree remove failed",
            ));
        }
    } else {
        // Incomplete create: fail closed rather than raw recursive delete.
        return Err(PoolError::new(
            PoolErrorCode::WorktreeCleanupFailed,
            "incomplete worktree left without linked .git; manual quarantine",
        ));
    }
    Ok(())
}

// --- filesystem owner-private modes (Unix fail-closed); Windows no-op ---

fn ensure_regular_file_no_reparse(path: &Path, meta: &std::fs::Metadata) -> Result<(), PoolError> {
    reject_reparse(path)?;
    if meta.file_type().is_symlink() {
        return Err(PoolError::new(
            PoolErrorCode::PathEscape,
            "refusing symlink control file",
        ));
    }
    if !meta.is_file() {
        return Err(PoolError::new(
            PoolErrorCode::PathEscape,
            "control path is not a regular file",
        ));
    }
    Ok(())
}

fn create_dir_owner_private(path: &Path) -> Result<(), PoolError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(path)
            .map_err(|_| PoolError::new(PoolErrorCode::Io, "create dir with mode 0700 failed"))?;
        // Re-assert after create.
        set_dir_owner_private(path)?;
    }
    #[cfg(windows)]
    {
        std::fs::create_dir(path)
            .map_err(|_| PoolError::new(PoolErrorCode::Io, "create dir failed"))?;
    }
    Ok(())
}

/// Open/create a pool control file without following symlinks when possible.
fn open_file_owner_private(path: &Path, create: bool) -> Result<File, PoolError> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) => {
            ensure_regular_file_no_reparse(path, &meta)?;
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            if !create {
                return Err(PoolError::new(PoolErrorCode::Io, "control file missing"));
            }
        }
        Err(_) => {
            return Err(PoolError::new(
                PoolErrorCode::Io,
                "stat control file failed",
            ));
        }
    }
    let mut opts = OpenOptions::new();
    opts.read(true).write(true);
    if create {
        opts.create(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
        // Do not follow a racing symlink at open time.
        opts.custom_flags(libc::O_NOFOLLOW);
    }
    opts.open(path)
        .map_err(|_| PoolError::new(PoolErrorCode::Io, "open private file failed"))
}

fn open_existing_control_file(path: &Path) -> Result<File, PoolError> {
    open_file_owner_private(path, false)
}

fn set_dir_owner_private(path: &Path) -> Result<(), PoolError> {
    #[cfg(unix)]
    {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| PoolError::new(PoolErrorCode::Io, "set directory mode 0700 failed"))?;
    }
    #[cfg(windows)]
    {
        let _ = path;
    }
    Ok(())
}

fn set_file_owner_private(path: &Path) -> Result<(), PoolError> {
    #[cfg(unix)]
    {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|_| PoolError::new(PoolErrorCode::Io, "set file mode 0600 failed"))?;
    }
    #[cfg(windows)]
    {
        let _ = path;
    }
    Ok(())
}

// --- git helper ---

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GitRunError {
    Timeout,
    Lock,
    Auth,
    NotFound,
    Network,
    PathTooLong,
    DiskFull,
    PermissionDenied,
    PathExists,
    RefUnresolved,
    Failed,
}

impl GitRunError {
    fn as_str(self) -> &'static str {
        match self {
            Self::Timeout => "timed out",
            Self::Lock => "lock contention",
            Self::Auth => "authentication failed",
            Self::NotFound => "repository not found",
            Self::Network => "could not reach the remote",
            Self::PathTooLong => "path too long",
            Self::DiskFull => "disk full",
            Self::PermissionDenied => "permission denied",
            Self::PathExists => "path already registered or in use",
            Self::RefUnresolved => "ref unresolved",
            Self::Failed => "git command failed",
        }
    }
}

/// Classify a failed git invocation from sanitized stderr keywords only.
/// Never return raw stderr: it may contain remote URLs with userinfo/tokens.
fn classify_git_failure(stderr: &str) -> GitRunError {
    let lower = stderr.to_ascii_lowercase();
    // Filesystem limits first: their stderr often also says "unable to create",
    // which would otherwise be misread as lock contention.
    if lower.contains("filename too long") || lower.contains("file name too long") {
        return GitRunError::PathTooLong;
    }
    if lower.contains("no space left on device") || lower.contains("disk quota exceeded") {
        return GitRunError::DiskFull;
    }
    if lower.contains("unable to create")
        || lower.contains("cannot lock ref")
        || lower.contains("index.lock")
        || (lower.contains(".lock") && lower.contains("file exists"))
    {
        return GitRunError::Lock;
    }
    if lower.contains("authentication failed")
        || lower.contains("could not read username")
        || lower.contains("terminal prompts disabled")
        || lower.contains("permission denied (publickey)")
        || lower.contains("invalid username or token")
        || lower.contains("http basic: access denied")
        || lower.contains("the requested url returned error: 401")
        || lower.contains("the requested url returned error: 403")
    {
        return GitRunError::Auth;
    }
    if lower.contains("repository not found") || lower.contains("the requested url returned error: 404") {
        return GitRunError::NotFound;
    }
    if lower.contains("could not resolve host")
        || lower.contains("failed to connect")
        || lower.contains("connection timed out")
        || lower.contains("operation timed out")
        || lower.contains("connection refused")
        || lower.contains("connection reset")
        || lower.contains("network is unreachable")
        || lower.contains("early eof")
        || lower.contains("unexpected disconnect")
        || lower.contains("the remote end hung up")
        || lower.contains("rpc failed")
        || lower.contains("gnutls")
        || lower.contains("ssl_")
        || lower.contains("tls connection")
    {
        return GitRunError::Network;
    }
    if lower.contains("permission denied") || lower.contains("operation not permitted") {
        return GitRunError::PermissionDenied;
    }
    if lower.contains("already exists")
        || lower.contains("already registered worktree")
        || lower.contains("already checked out")
        || lower.contains("already used by worktree")
    {
        return GitRunError::PathExists;
    }
    if lower.contains("not a valid object name")
        || lower.contains("invalid reference")
        || lower.contains("unknown revision")
        || lower.contains("not a valid ref")
    {
        return GitRunError::RefUnresolved;
    }
    GitRunError::Failed
}

/// Run git. On failure returns a classified error only — never raw stderr
/// (may contain credentials/URLs). Callers map to stable `PoolErrorCode`.
/// Every Git command the pool and run worktrees start: no console window,
/// no fsmonitor, the current grant's credentials, and no repository bindings
/// inherited from a hook (explicit `-C` commands must not mutate the hook's
/// caller), with prompts off and no stdin.
pub(crate) fn background_git_command() -> tokio::process::Command {
    let mut command = tokio::process::Command::new("git");
    xmatrix_process_tree::hide_tokio_console_window(&mut command);
    command.args(["-c", "core.fsmonitor=false"]);
    apply_git_credential_helper(&mut command);
    command
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(std::process::Stdio::null());
    command
}

pub(crate) fn git_command(cwd: &Path, args: &[&str]) -> tokio::process::Command {
    let mut command = background_git_command();
    command.arg("-C").arg(cwd).args(args);
    command
}

async fn git(cwd: &Path, args: &[&str], timeout: Duration) -> Result<String, GitRunError> {
    let mut command = git_command(cwd, args);
    command
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    xmatrix_process_tree::configure_tokio_process_tree(&mut command);
    let mut child = command.spawn().map_err(|_| GitRunError::Failed)?;
    // A timed-out fetch also stops the helpers it started (ssh, credentials).
    let mut tree =
        xmatrix_process_tree::guard_tokio_child(&mut child).map_err(|_| GitRunError::Failed)?;
    let output = match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Err(_) => {
            let _ = tree.terminate();
            return Err(GitRunError::Timeout);
        }
        Ok(Err(_)) => return Err(GitRunError::Failed),
        Ok(Ok(output)) => output,
    };
    if !output.status.success() {
        return Err(classify_git_failure(&String::from_utf8_lossy(
            &output.stderr,
        )));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Point this Git invocation at the current grant, if one exists.
///
/// No grant means the host's own helpers stay untouched. A grant clears those
/// helpers so the fetch cannot silently widen to another Space's login.
/// Whether this task carries a Space's Git grant. When it does, the Space — not
/// the machine's own GitHub login — is what authorizes the repository, so any
/// command that could authenticate on its own must route through Git instead.
pub(crate) fn space_scoped_git_capability() -> bool {
    git_credential::scoped_or_env_capability().is_some()
}

pub(crate) fn apply_git_credential_helper(command: &mut tokio::process::Command) {
    let Some(capability) = git_credential::scoped_or_env_capability() else {
        return;
    };
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    command.args(git_credential::git_credential_config_args(
        &git_credential::git_credential_helper_command(&exe),
    ));
    command.env(git_credential::GIT_CREDENTIAL_CAPABILITY_ENV, capability);
}

// --- string helpers ---

use xmatrix_cli_core::hex::sha256_hex as hex_sha256;

fn now_rfc3339() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

/// Bound + redact credential-like material for operator-facing messages.
/// Truncation is always on a UTF-8 char boundary (never panics on multi-byte).
fn sanitize_detail(raw: &str) -> String {
    let mut s = raw.to_string();
    // URL userinfo: scheme://user:pass@host → scheme://***@host
    if let Some(scheme_end) = s.find("://") {
        let after = scheme_end + 3;
        if let Some(at) = s[after..].find('@') {
            let at_abs = after + at;
            let slash = s[after..].find('/').map(|i| after + i).unwrap_or(s.len());
            if at_abs < slash && s.is_char_boundary(after) && s.is_char_boundary(at_abs) {
                s.replace_range(after..at_abs, "***");
            }
        }
    }
    // scp-like user@host:path credentials
    if let Some(at) = s.find('@')
        && s.is_char_boundary(at) && !s[..at].contains("://")
            && let Some(colon) = s[at..].find(':') {
                let host_end = at + colon;
                if s[..at]
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
                {
                    s.replace_range(..at, "***");
                    let _ = host_end;
                }
            }
    // Strip query/fragment content
    if let Some(q) = s.find('?')
        && s.is_char_boundary(q) {
            s.truncate(q);
            s.push_str("?<redacted>");
        }
    if let Some(h) = s.find('#')
        && s.is_char_boundary(h) {
            s.truncate(h);
            s.push_str("#<redacted>");
        }
    // Collapse obvious token-looking substrings
    for needle in ["token=", "access_token=", "password=", "secret="] {
        if let Some(i) = s.to_ascii_lowercase().find(needle) {
            let start = i + needle.len();
            if !s.is_char_boundary(start) {
                continue;
            }
            let end = s[start..]
                .find(['&', ' ', ';', '"'])
                .map(|e| start + e)
                .unwrap_or(s.len());
            if end > start && s.is_char_boundary(end) {
                s.replace_range(start..end, "***");
            }
        }
    }
    truncate_str_at_char_boundary(&mut s, MAX_SANITIZED_DETAIL);
    s
}

fn truncate_str_at_char_boundary(s: &mut String, max_bytes: usize) {
    if s.len() <= max_bytes {
        return;
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s.truncate(end);
    s.push_str("...");
}

fn looks_like_local_path(value: &str) -> bool {
    value.starts_with("file:")
        || value.starts_with('.')
        || value.starts_with('/')
        || value.starts_with('\\')
        || (value.len() >= 3
            && value.as_bytes()[0].is_ascii_alphabetic()
            && value.as_bytes()[1] == b':'
            && (value.as_bytes()[2] == b'\\' || value.as_bytes()[2] == b'/'))
        || value.starts_with("\\\\")
}

fn is_owner_repo(value: &str) -> bool {
    let value = strip_optional_dot_git(value);
    let parts: Vec<_> = value.split('/').collect();
    parts.len() == 2
        && parts.iter().all(|p| {
            !p.is_empty()
                && p.chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        })
}

fn identity_url_path<'a>(url: &'a url::Url, missing_path: &str) -> Result<&'a str, PoolError> {
    let path = url.path().strip_prefix('/').unwrap_or(url.path());
    let path = strip_optional_dot_git(path);
    if path.is_empty() {
        return Err(PoolError::new(PoolErrorCode::InvalidIdentity, missing_path));
    }
    Ok(path)
}

fn parse_http_identity(input: &str) -> Result<Option<String>, PoolError> {
    let lower = input.to_ascii_lowercase();
    if !lower.starts_with("http://") && !lower.starts_with("https://") {
        return Ok(None);
    }
    let url = url::Url::parse(input)
        .map_err(|_| PoolError::new(PoolErrorCode::InvalidIdentity, "invalid http repo URL"))?;
    let host = url
        .host_str()
        .ok_or_else(|| PoolError::new(PoolErrorCode::InvalidIdentity, "http url missing host"))?;
    let path = identity_url_path(&url, "http url missing path")?;
    let host_lower = normalize_scp_host(host)?;
    let port = url.port();
    let default_port = if url.scheme() == "http" { 80 } else { 443 };
    if host_lower == "github.com" && port.is_none_or(|value| value == default_port) {
        return Ok(Some(exact_github_owner_repo(path)?));
    }
    if port.is_some() || host_requires_scheme(&host_lower) {
        return Ok(Some(format!(
            "{}://{}/{path}",
            url.scheme(),
            format_host_port(&host_lower, port)
        )));
    }
    Ok(Some(format!(
        "{}/{path}",
        format_host_port(&host_lower, port)
    )))
}

fn exact_github_owner_repo(path: &str) -> Result<String, PoolError> {
    // Do NOT collapse empty segments: owner//repo must fail.
    let parts: Vec<_> = path.split('/').collect();
    if parts.len() != 2 || parts[0].is_empty() || parts[1].is_empty() {
        return Err(PoolError::new(
            PoolErrorCode::InvalidIdentity,
            "github path must be exactly owner/repo",
        ));
    }
    if !parts[0]
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        || !parts[1]
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err(PoolError::new(
            PoolErrorCode::InvalidIdentity,
            "github owner/repo contains invalid characters",
        ));
    }
    Ok(format!(
        "github.com/{}/{}",
        parts[0].to_ascii_lowercase(),
        parts[1].to_ascii_lowercase()
    ))
}

fn parse_ssh_url_identity(input: &str) -> Result<Option<String>, PoolError> {
    if !input.to_ascii_lowercase().starts_with("ssh://") {
        return Ok(None);
    }
    let url = url::Url::parse(input)
        .map_err(|_| PoolError::new(PoolErrorCode::InvalidIdentity, "invalid ssh repo URL"))?;
    let host = url
        .host_str()
        .ok_or_else(|| PoolError::new(PoolErrorCode::InvalidIdentity, "ssh url missing host"))?;
    let path = identity_url_path(&url, "ssh url missing path")?;
    let host_lower = host.to_ascii_lowercase();
    let port = url.port();
    if host_lower == "github.com" && port.is_none_or(|value| value == 22) {
        return Ok(Some(exact_github_owner_repo(path)?));
    }
    if port.is_some() || host_requires_scheme(&host_lower) {
        return Ok(Some(format!(
            "ssh://{}/{path}",
            format_host_port(&host_lower, port)
        )));
    }
    Ok(Some(format!(
        "{}/{path}",
        format_host_port(&host_lower, port)
    )))
}

fn parse_scp_identity(input: &str) -> Result<Option<String>, PoolError> {
    if input.contains("://") {
        return Ok(None);
    }
    if input.contains(['?', '#']) {
        return Err(PoolError::new(
            PoolErrorCode::InvalidIdentity,
            "scp-like repo path contains ambiguous query/fragment characters",
        ));
    }
    let separator = if let Some(bracket_end) = input.find("]:") {
        bracket_end + 1
    } else if let Some(colon) = input.find(':') {
        colon
    } else {
        return Ok(None);
    };
    let user_host = &input[..separator];
    let path = &input[separator + 1..];
    if user_host.len() == 1 {
        return Ok(None);
    }
    let host = user_host
        .rsplit_once('@')
        .map(|(_, h)| h)
        .unwrap_or(user_host);
    if host.is_empty() || host.contains(['/', '?', '#']) {
        return Ok(None);
    }
    if (host.starts_with('[') || host.ends_with(']'))
        && !(host.starts_with('[') && host.ends_with(']') && host[1..host.len() - 1].contains(':'))
    {
        return Err(PoolError::new(
            PoolErrorCode::InvalidIdentity,
            "scp-like IPv6 host brackets invalid",
        ));
    }
    let path = strip_optional_dot_git(path);
    if path.is_empty() {
        return Err(PoolError::new(
            PoolErrorCode::InvalidIdentity,
            "scp path empty",
        ));
    }
    let host_lower = normalize_scp_host(host)?;
    if host_lower == "github.com" {
        return Ok(Some(exact_github_owner_repo(path)?));
    }
    if host_requires_scheme(&host_lower) {
        return Ok(Some(format!(
            "ssh://{}/{path}",
            format_host_port(&host_lower, None)
        )));
    }
    Ok(Some(format!(
        "{}/{path}",
        format_host_port(&host_lower, None)
    )))
}

fn parse_host_path_identity(input: &str) -> Option<String> {
    if input.contains(['?', '#']) {
        return None;
    }
    let input = strip_optional_dot_git(input);
    let (host_port, path) = input.split_once('/')?;
    if host_port.is_empty() || path.is_empty() || host_port.contains('@') {
        return None;
    }
    // Git's unqualified `host:thing/path` syntax is scp-like: `thing` is the
    // first path segment even when numeric. Never reinterpret it as a port.
    // Bracketed IPv6 without a port remains a valid canonical host spelling.
    if host_port.contains(':') && !(host_port.starts_with('[') && host_port.ends_with(']')) {
        return None;
    }
    let authority = url::Url::parse(&format!("ssh://{host_port}/")).ok()?;
    let host = authority.host_str()?;
    if !host.contains('.') && !host.contains(':') {
        return None;
    }
    let host_lower = host.to_ascii_lowercase();
    let port = authority.port();
    if host_lower == "github.com" && port.is_none() {
        return exact_github_owner_repo(path).ok();
    }
    Some(format!("{}/{path}", format_host_port(&host_lower, port)))
}

/// Remove trailing slashes and at most one conventional transport suffix.
/// Repeated `.git` is meaningful (`repo.git.git` → repo named `repo.git`) and
/// must not collide with `repo`.
fn strip_optional_dot_git(value: &str) -> &str {
    let value = value.trim_end_matches('/');
    value.strip_suffix(".git").unwrap_or(value)
}

fn format_host_port(host: &str, port: Option<u16>) -> String {
    let host = if host.starts_with('[') && host.ends_with(']') {
        host.to_string()
    } else if host.contains(':') {
        format!("[{host}]")
    } else {
        host.to_string()
    };
    match port {
        Some(port) => format!("{host}:{port}"),
        None => host,
    }
}

/// Normalize an scp-like host through the same URL/IDNA parser used for URL
/// remotes. This makes Unicode DNS names, punycode, bracketed IPv6, and ASCII
/// case converge before the repo identity is hashed.
fn normalize_scp_host(host: &str) -> Result<String, PoolError> {
    // `ssh` is a non-special URL scheme, so the URL parser percent-encodes a
    // Unicode host instead of applying IDNA. Use an HTTPS authority only as a
    // host parser; the caller still preserves the actual Git transport.
    let url = url::Url::parse(&format!("https://{host}/")).map_err(|_| {
        PoolError::new(
            PoolErrorCode::InvalidIdentity,
            "scp-like repo host is invalid",
        )
    })?;
    if url.port().is_some() {
        return Err(PoolError::new(
            PoolErrorCode::InvalidIdentity,
            "scp-like host must not encode a URL port",
        ));
    }
    url.host_str()
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| PoolError::new(PoolErrorCode::InvalidIdentity, "scp-like host is missing"))
}

/// A dotless, non-IP hostname such as `gitbox` or `localhost` is ambiguous
/// with GitHub owner/repo shorthand once transport syntax is removed. Preserve
/// a scheme for those authorities so canonicalization stays idempotent.
fn host_requires_scheme(host: &str) -> bool {
    let host = host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host);
    !host.contains('.') && !host.contains(':')
}
