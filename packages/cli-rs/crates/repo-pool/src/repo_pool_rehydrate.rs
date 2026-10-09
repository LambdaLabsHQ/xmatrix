// --- rehydrate: wake a resting session whose slot the sweep reclaimed ---
//
// A Retained slot is where its resting Instance wakes, and its disk is exactly
// what a pool full of sleeping Instances cannot keep (docs/instance-sleep.md
// §6). The reclaim sweep may therefore evict a resting slot, but only after it
// wrote down everything the session's checkout was: the commit at HEAD, the
// branch it was on, and whether that commit is the snapshot of a dirty tree.
// A later reborn of the session recreates a linked worktree at the *same*
// path from that record, so the harness transcript (keyed by the directory)
// and every absolute path in the conversation stay valid. Only ignored build
// output is gone.
//
// Records live beside the manifest in their own file, so an older daemon that
// does not know them still loads the pool.

const REHYDRATE_FILE: &str = "rehydrate.json";
const REHYDRATE_VERSION: u8 = 1;
const MAX_REHYDRATE_RECORDS: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RehydrateRecord {
    pub session_key: String,
    pub instance_id: String,
    pub run_id: String,
    pub execution_key: String,
    pub slot_id: String,
    pub head_oid: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// HEAD is the pool's snapshot commit of a dirty tree; rehydrate turns it
    /// back into uncommitted changes.
    #[serde(default)]
    pub dirty_snapshot: bool,
    pub last_base_ref: String,
    pub last_base_oid: String,
    pub evicted_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RehydrateFile {
    version: u8,
    records: Vec<RehydrateRecord>,
}

fn rehydrate_path(layout: &RepoPoolLayout) -> PathBuf {
    layout.pool_root().join(REHYDRATE_FILE)
}

fn load_rehydrate_records(layout: &RepoPoolLayout) -> Result<Vec<RehydrateRecord>, PoolError> {
    let path = rehydrate_path(layout);
    let Some(raw) = read_private_pool_record(&path, "rehydrate records")? else { return Ok(Vec::new()); };
    let file: RehydrateFile = serde_json::from_slice(&raw)
        .map_err(|_| PoolError::new(PoolErrorCode::ManifestCorrupt, "rehydrate records invalid"))?;
    if file.version != REHYDRATE_VERSION {
        return Err(PoolError::new(
            PoolErrorCode::ManifestCorrupt,
            "rehydrate records version unsupported",
        ));
    }
    for record in &file.records {
        validate_rehydrate_record(record)?;
    }
    Ok(file.records)
}

fn save_rehydrate_records(
    layout: &RepoPoolLayout,
    records: &[RehydrateRecord],
) -> Result<(), PoolError> {
    let pool_root = layout.pool_root();
    if !pool_root.is_dir() {
        return Err(PoolError::new(
            PoolErrorCode::PathEscape,
            "pool root missing at rehydrate save",
        ));
    }
    let final_path = rehydrate_path(layout);
    if let Ok(meta) = std::fs::symlink_metadata(&final_path) {
        ensure_regular_file_no_reparse(&final_path, &meta)?;
    }
    let json = serde_json::to_vec_pretty(&RehydrateFile {
        version: REHYDRATE_VERSION,
        records: records.to_vec(),
    })
    .map_err(|_| {
        PoolError::new(
            PoolErrorCode::Internal,
            "serialize rehydrate records failed",
        )
    })?;
    let temp_path = xmatrix_cli_core::config::unique_temporary_path(&final_path);
    write_private_pool_record(&temp_path, &final_path, &json, "rehydrate")
}

fn validate_rehydrate_record(record: &RehydrateRecord) -> Result<(), PoolError> {
    validate_binding_field("sessionKey", &record.session_key)?;
    validate_binding_field("instanceId", &record.instance_id)?;
    validate_binding_field("runId", &record.run_id)?;
    validate_binding_field("executionKey", &record.execution_key)?;
    SlotId::parse(&record.slot_id)?;
    validate_oid(&record.head_oid)?;
    validate_oid(&record.last_base_oid)?;
    validate_base_ref(&record.last_base_ref)?;
    if let Some(branch) = record.branch.as_deref()
        && (branch.is_empty()
            || branch.len() > MAX_ID_CHARS
            || branch.starts_with('-')
            || branch.chars().any(|c| c.is_control() || c.is_whitespace()))
        {
            return Err(PoolError::new(
                PoolErrorCode::InvalidBinding,
                "rehydrate branch invalid",
            ));
        }
    validate_updated_at(&record.evicted_at)
}

/// Keep the newest record per session, and no more than the bound.
fn remember_rehydrate_record(records: &mut Vec<RehydrateRecord>, record: RehydrateRecord) {
    records.retain(|existing| existing.session_key != record.session_key);
    records.push(record);
    if records.len() > MAX_REHYDRATE_RECORDS {
        let surplus = records.len() - MAX_REHYDRATE_RECORDS;
        records.drain(..surplus);
    }
}

/// Everything a reclaimed checkout was, read after the eviction snapshot so a
/// dirty tree is already its snapshot commit.
async fn capture_rehydrate_record(
    worktree: &Path,
    binding: &BindingRecord,
    slot: &SlotRecord,
    snapshot: SnapshotOutcome,
) -> Result<RehydrateRecord, PoolError> {
    let head_oid = git(
        worktree,
        &["rev-parse", "--verify", "HEAD"],
        GIT_LOCAL_TIMEOUT,
    )
    .await
    .map_err(|_| {
        PoolError::new(
            PoolErrorCode::SnapshotCommitFailed,
            "rehydrate HEAD unreadable",
        )
    })?;
    validate_oid(&head_oid)?;
    // Detached HEAD is a normal pool state: no branch then.
    let branch = git(
        worktree,
        &["symbolic-ref", "--quiet", "--short", "HEAD"],
        GIT_LOCAL_TIMEOUT,
    )
    .await
    .ok()
    .map(|value| value.trim().to_string())
    .filter(|value| !value.is_empty());
    let (last_base_ref, last_base_oid) =
        match (slot.last_base_ref.clone(), slot.last_base_oid.clone()) {
            (Some(base_ref), Some(base_oid)) => (base_ref, base_oid),
            _ => {
                return Err(PoolError::new(
                    PoolErrorCode::ManifestCorrupt,
                    "rehydrate slot missing its base",
                ));
            }
        };
    let record = RehydrateRecord {
        session_key: binding.session_key.clone(),
        instance_id: binding.instance_id.clone(),
        run_id: binding.run_id.clone(),
        execution_key: binding.execution_key.clone(),
        slot_id: binding.slot_id.clone(),
        head_oid,
        branch,
        dirty_snapshot: snapshot.dirty_commit,
        last_base_ref,
        last_base_oid,
        evicted_at: now_rfc3339(),
    };
    validate_rehydrate_record(&record)?;
    Ok(record)
}

/// The rehydrate record for a session this machine no longer holds a slot
/// for. `None` when the session is still bound (reborn rebinds it) or was
/// never reclaimed.
pub async fn rehydrate_record_for_session_at(
    layout: &RepoPoolLayout,
    session_key: &str,
) -> Result<Option<RehydrateRecord>, PoolError> {
    validate_binding_field("sessionKey", session_key)?;
    let _guard = acquire_pool_guard(layout).await?;
    let Some(manifest) = load_for_update(layout)? else {
        return Ok(None);
    };
    if manifest
        .bindings
        .iter()
        .any(|binding| binding.session_key == session_key)
    {
        return Ok(None);
    }
    Ok(load_rehydrate_records(layout)?
        .into_iter()
        .find(|record| record.session_key == session_key))
}

/// Recreate a reclaimed session's checkout at its recorded path and bind it to
/// the reborn successor, entering `Starting` like any lease. Fails closed when
/// the path or slot id is taken, or the recorded commit is unreachable.
pub async fn rehydrate_retained_lease_at(
    layout: &RepoPoolLayout,
    base_repo: &Path,
    record: &RehydrateRecord,
    request: &LeaseRequest,
) -> Result<LeaseResult, PoolError> {
    validate_rehydrate_record(record)?;
    validate_request(request)?;
    if request.session_key != record.session_key || request.instance_id != record.instance_id {
        return Err(PoolError::new(
            PoolErrorCode::InvalidBinding,
            "rehydrate must continue the recorded session and Instance",
        ));
    }
    let _guard = acquire_pool_guard(layout).await?;
    let pool_root = layout.pool_root();
    let mut manifest = load_for_update(layout)?
        .ok_or_else(|| PoolError::new(PoolErrorCode::ManifestCorrupt, "pool manifest missing"))?;
    let mut records = load_rehydrate_records(layout)?;
    if !records.iter().any(|existing| existing == record) {
        return Err(PoolError::new(
            PoolErrorCode::InvalidBinding,
            "rehydrate record changed",
        ));
    }
    if manifest
        .bindings
        .iter()
        .any(|binding| binding.session_key == record.session_key)
    {
        return Err(PoolError::new(
            PoolErrorCode::InvalidBinding,
            "rehydrate session is still bound",
        ));
    }
    let slot_id = SlotId::parse(&record.slot_id)?;
    let path = layout.slot_path(&slot_id)?;
    let component = layout.slot_component(&slot_id);
    let slot_taken = manifest.slots.keys().any(|key| {
        if layout.is_compact() {
            &key[..SLOT_DIR_CHARS] == component
        } else {
            key == component
        }
    });
    if slot_taken || std::fs::symlink_metadata(&path).is_ok() {
        return Err(PoolError::new(
            PoolErrorCode::InvalidSlotId,
            "rehydrate path is no longer free",
        ));
    }
    let identity = canonical_repo_identity(&manifest.canonical_repo_identity)?;
    verify_base_matches_identity(base_repo, &identity).await?;
    manifest.slots.insert(
        slot_id.as_str().to_string(),
        SlotRecord::preparing(&slot_id),
    );
    save_manifest_at(pool_root, &manifest)?;
    if let Err(err) = recreate_rehydrated_tree(layout, base_repo, &path, &slot_id, record).await {
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
        drop_slot_from_manifest(&mut manifest, slot_id.as_str());
        save_manifest_at(pool_root, &manifest)?;
        return Err(err);
    }
    let spawn_claim_token = bind_new_starting_slot(
        pool_root,
        &mut manifest,
        &slot_id,
        request,
        &record.last_base_ref,
        &record.last_base_oid,
    )?;
    // The checkout is bound again; its record would only mislead a later reborn.
    records.retain(|existing| existing.session_key != record.session_key);
    save_rehydrate_records(layout, &records)?;
    Ok(LeaseResult {
        slot_id,
        worktree_path: path,
        base_ref: record.last_base_ref.clone(),
        reused_available: false,
        spawn_claim_token,
        baseline: None,
    })
}

async fn recreate_rehydrated_tree(
    layout: &RepoPoolLayout,
    base_repo: &Path,
    path: &Path,
    slot_id: &SlotId,
    record: &RehydrateRecord,
) -> Result<(), PoolError> {
    let path_arg = path.display().to_string();
    git(
        base_repo,
        &[
            "-c",
            "worktree.useRelativePaths=false",
            "worktree",
            "add",
            "--detach",
            &path_arg,
            &record.head_oid,
        ],
        GIT_WORKTREE_ADD_TIMEOUT,
    )
    .await
    .map_err(|error| {
        PoolError::new(
            PoolErrorCode::WorktreeCreateFailed,
            format!("rehydrate worktree add failed ({})", error.as_str()),
        )
    })?;
    if !path.join(".git").is_file() {
        return Err(PoolError::new(
            PoolErrorCode::WorktreeCreateFailed,
            "rehydrate did not produce a linked .git file",
        ));
    }
    set_dir_owner_private(path)?;
    verify_worktree_belongs_to_base(base_repo, path).await?;
    lock_pool_worktree(base_repo, path, layout, slot_id).await?;
    // Back on its branch only if nothing moved it and no other tree holds it;
    // otherwise the session continues from the same commit, detached.
    if let Some(branch) = record.branch.as_deref() {
        let tip = git(
            path,
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("refs/heads/{branch}"),
            ],
            GIT_LOCAL_TIMEOUT,
        )
        .await
        .ok();
        if tip.as_deref() == Some(record.head_oid.as_str()) {
            let _ = git(path, &["checkout", "--quiet", branch], GIT_MUTATION_TIMEOUT).await;
        }
    }
    if record.dirty_snapshot {
        git(
            path,
            &["reset", "--quiet", "--soft", "HEAD~1"],
            GIT_MUTATION_TIMEOUT,
        )
        .await
        .map_err(|_| PoolError::new(PoolErrorCode::ResetFailed, "rehydrate unsnapshot failed"))?;
        git(path, &["reset", "--quiet"], GIT_MUTATION_TIMEOUT)
            .await
            .map_err(|_| PoolError::new(PoolErrorCode::ResetFailed, "rehydrate unstage failed"))?;
    }
    Ok(())
}

// --- lost checkout: a resting tree removed behind the pool's back ---
//
// A Retained checkout can also disappear without the sweep: deleted by hand,
// by a disk cleaner, or half-removed by a delete that left only untracked
// residue. Its session must still wake where its transcript says it lives.
// Pool trees are locked, so `git worktree prune` keeps their admin entry, and
// that entry still names the HEAD and branch the session was on. With it the
// lost tree becomes a rehydrate record like a reclaimed one, and reborn
// recreates the checkout at the same path. Uncommitted edits went with the
// directory; when the admin entry is gone too, the slot's last base is the
// commit the session continues from.

#[derive(Debug, Default, PartialEq, Eq)]
struct LostCheckoutHead {
    head_oid: String,
    branch: Option<String>,
}

/// The `git worktree list --porcelain` entry for one pool slot, matched by the
/// pool's own lock reason or, failing that, by path.
fn parse_lost_checkout_head(
    porcelain: &str,
    lock_reason: &str,
    path: &Path,
) -> Option<LostCheckoutHead> {
    porcelain.split("\n\n").find_map(|entry| {
        let mut listed_path = None;
        let mut head = LostCheckoutHead::default();
        let mut locked_by_pool = false;
        for line in entry.lines() {
            if let Some(value) = line.strip_prefix("worktree ") {
                listed_path = Some(value);
            } else if let Some(value) = line.strip_prefix("HEAD ") {
                head.head_oid = value.trim().to_string();
            } else if let Some(value) = line.strip_prefix("branch refs/heads/") {
                head.branch = Some(value.trim().to_string());
            } else if let Some(value) = line.strip_prefix("locked ") {
                locked_by_pool = value.trim() == lock_reason;
            }
        }
        let same_path =
            listed_path.is_some_and(|listed| paths_equal_platform(Path::new(listed), path));
        (locked_by_pool || same_path).then_some(head)
    })
}

/// What git still records for a lost slot tree, if its commit is still there.
async fn lost_checkout_head(
    layout: &RepoPoolLayout,
    base_repo: &Path,
    slot_id: &SlotId,
    path: &Path,
) -> Option<LostCheckoutHead> {
    let porcelain = git(
        base_repo,
        &["worktree", "list", "--porcelain"],
        GIT_LOCAL_TIMEOUT,
    )
    .await
    .ok()?;
    let head = parse_lost_checkout_head(
        &porcelain,
        &pool_worktree_lock_reason(layout, slot_id),
        path,
    )?;
    validate_oid(&head.head_oid).ok()?;
    git(
        base_repo,
        &["cat-file", "-e", &format!("{}^{{commit}}", head.head_oid)],
        GIT_LOCAL_TIMEOUT,
    )
    .await
    .ok()?;
    Some(head)
}

/// Record a bound Retained slot whose checkout is gone for rehydrate, clear
/// what is left of it, and drop it from the manifest (the caller saves it).
/// `Ok(false)` when the tree is intact or the slot is not a resting session's.
async fn record_lost_checkout(
    layout: &RepoPoolLayout,
    base_repo: &Path,
    manifest: &mut RepoPoolManifest,
    slot_id: &str,
) -> Result<bool, PoolError> {
    let parsed = SlotId::parse(slot_id)?;
    let path = layout.slot_path(&parsed)?;
    if path.join(".git").is_file() {
        return Ok(false);
    }
    let Some(slot) = manifest
        .slots
        .get(slot_id)
        .filter(|slot| slot.state == SlotState::Retained)
    else {
        return Ok(false);
    };
    let Some(binding) = manifest
        .bindings
        .iter()
        .find(|binding| binding.slot_id == slot_id)
    else {
        return Ok(false);
    };
    let (Some(last_base_ref), Some(last_base_oid)) =
        (slot.last_base_ref.clone(), slot.last_base_oid.clone())
    else {
        return Err(PoolError::new(
            PoolErrorCode::ManifestCorrupt,
            "lost checkout slot missing its base",
        ));
    };
    let head = lost_checkout_head(layout, base_repo, &parsed, &path)
        .await
        .unwrap_or_else(|| LostCheckoutHead {
            head_oid: last_base_oid.clone(),
            branch: None,
        });
    let record = RehydrateRecord {
        session_key: binding.session_key.clone(),
        instance_id: binding.instance_id.clone(),
        run_id: binding.run_id.clone(),
        execution_key: binding.execution_key.clone(),
        slot_id: slot_id.to_string(),
        head_oid: head.head_oid,
        branch: head.branch,
        dirty_snapshot: false,
        last_base_ref,
        last_base_oid,
        evicted_at: now_rfc3339(),
    };
    validate_rehydrate_record(&record)?;
    let mut records = load_rehydrate_records(layout)?;
    remember_rehydrate_record(&mut records, record);
    save_rehydrate_records(layout, &records)?;
    // Free the path for the rehydrated tree: git's entry first, then residue.
    let path_arg = path.display().to_string();
    let _ = git(
        base_repo,
        &["worktree", "unlock", &path_arg],
        GIT_LOCAL_TIMEOUT,
    )
    .await;
    remove_leftover_idle_slot_directory(layout, base_repo, &path).await?;
    drop_slot_from_manifest(manifest, slot_id);
    Ok(true)
}

/// The pool's pinned parent checkout when it is still there, else `provided`.
fn lost_checkout_base(manifest: &RepoPoolManifest, provided: Option<&Path>) -> Option<PathBuf> {
    manifest
        .base_repo_path
        .as_deref()
        .map(PathBuf::from)
        .filter(|path| path.is_absolute() && path.is_dir())
        .or_else(|| provided.map(Path::to_path_buf))
}

/// Reborn of a session whose retained checkout was removed outside the pool:
/// turn it into a rehydrate record so the reborn recreates it in place.
/// `Ok(false)` when the session's tree is intact or it holds no slot.
pub async fn record_lost_retained_checkout_at(
    layout: &RepoPoolLayout,
    base_repo: &Path,
    session_key: &str,
) -> Result<bool, PoolError> {
    validate_binding_field("sessionKey", session_key)?;
    let _guard = acquire_pool_guard(layout).await?;
    let Some(mut manifest) = load_for_update(layout)? else {
        return Ok(false);
    };
    let Some(slot_id) = manifest
        .bindings
        .iter()
        .find(|binding| binding.session_key == session_key)
        .map(|binding| binding.slot_id.clone())
    else {
        return Ok(false);
    };
    let base =
        lost_checkout_base(&manifest, Some(base_repo)).expect("a provided base always resolves");
    if !record_lost_checkout(layout, &base, &mut manifest, &slot_id).await? {
        return Ok(false);
    }
    save_manifest_at(layout.pool_root(), &manifest)?;
    Ok(true)
}
