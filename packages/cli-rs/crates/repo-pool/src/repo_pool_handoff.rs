/// Exact sleeping checkout or its eviction snapshot. The guard prevents a
/// concurrent reclaim, return or rebind until the handoff export finishes.
pub struct RetainedHandoffSource {
    pub cwd: PathBuf,
    pub captured: Option<crate::run_worktree::HandoffWork>,
    _guard: PoolGuard,
}

pub async fn retained_handoff_source_at(
    layout: &RepoPoolLayout,
    authority: &BindingAuthority,
) -> Result<RetainedHandoffSource, PoolError> {
    validate_authority(authority)?;
    let guard = acquire_pool_guard(layout).await?;
    let manifest = load_for_update(layout)?
        .ok_or_else(|| PoolError::new(PoolErrorCode::ManifestCorrupt, "pool manifest missing"))?;
    let identity = canonical_repo_identity(&manifest.canonical_repo_identity)?;
    if manifest
        .bindings
        .iter()
        .any(|b| b.session_key == authority.session_key)
    {
        let index = find_exact_authority_index(&manifest, authority)?;
        let binding = &manifest.bindings[index];
        require_retained_slot(&manifest, &binding.slot_id)?;
        let slot_id = SlotId::parse(&authority.slot_id)?;
        let cwd = layout.slot_path(&slot_id)?;
        let base = registered_base_repo_for_worktree(&cwd).await?;
        verify_base_matches_identity(&base, &identity).await?;
        verify_pool_worktree_ownership(layout, &base, &cwd, &slot_id).await?;
        return Ok(RetainedHandoffSource {
            cwd,
            captured: None,
            _guard: guard,
        });
    }
    // Eviction preserves dirty work as a pinned commit. Export it directly
    // from the recorded parent without creating a new lease or substituting
    // the current main checkout for the sleeping session's work.
    let record = load_rehydrate_records(layout)?
        .into_iter()
        .find(|record| {
            record.session_key == authority.session_key
                && record.instance_id == authority.instance_id
                && record.run_id == authority.run_id
                && record.execution_key == authority.execution_key
                && record.slot_id == authority.slot_id
        })
        .ok_or_else(|| {
            PoolError::new(
                PoolErrorCode::InvalidBinding,
                "exact retained handoff record missing",
            )
        })?;
    let cwd = manifest
        .base_repo_path
        .as_deref()
        .map(PathBuf::from)
        .ok_or_else(|| PoolError::new(PoolErrorCode::InvalidBinding, "pool parent missing"))?;
    verify_base_matches_identity(&cwd, &identity).await?;
    let commit = git(
        &cwd,
        &[
            "rev-parse",
            "--verify",
            &format!("{}^{{commit}}", record.head_oid),
        ],
        GIT_LOCAL_TIMEOUT,
    )
    .await
    .map_err(|_| {
        PoolError::new(
            PoolErrorCode::SnapshotCommitFailed,
            "retained snapshot unavailable",
        )
    })?;
    let base = if record.dirty_snapshot {
        git(
            &cwd,
            &["rev-parse", "--verify", &format!("{}~1", record.head_oid)],
            GIT_LOCAL_TIMEOUT,
        )
        .await
        .map_err(|_| {
            PoolError::new(
                PoolErrorCode::SnapshotCommitFailed,
                "retained snapshot parent unavailable",
            )
        })?
    } else {
        commit.clone()
    };
    Ok(RetainedHandoffSource {
        cwd,
        captured: Some(crate::run_worktree::HandoffWork {
            commit,
            base,
            dirty: record.dirty_snapshot,
        }),
        _guard: guard,
    })
}
