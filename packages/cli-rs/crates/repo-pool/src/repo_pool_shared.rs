// Explicit reborn after handoff may share a checkout with its successor. The
// manifest retains separate session lifecycles so one exit cannot retire the
// other's lease or make its worktree recyclable.

fn validate_shared_binding(binding: &BindingRecord) -> Result<(), PoolError> {
    match binding.state {
        None if binding.spawn_claim_token.is_none() => Ok(()),
        Some(SlotState::Starting) => {
            validate_spawn_claim_token(binding.spawn_claim_token.as_deref().unwrap_or_default())
        }
        Some(SlotState::Leased | SlotState::Retained) if binding.spawn_claim_token.is_none() => {
            Ok(())
        }
        _ => Err(PoolError::new(
            PoolErrorCode::InvalidBinding,
            "invalid shared session lifecycle",
        )),
    }
}

fn make_slot_shared(manifest: &mut RepoPoolManifest, slot_id: &str) -> Result<(), PoolError> {
    let slot = manifest
        .slots
        .get(slot_id)
        .ok_or_else(|| PoolError::new(PoolErrorCode::InvalidSlotId, "shared slot missing"))?;
    for binding in manifest
        .bindings
        .iter_mut()
        .filter(|binding| binding.slot_id == slot_id)
    {
        if binding.state.is_none() {
            binding.state = Some(slot.state);
            binding.spawn_claim_token = slot.spawn_claim_token.clone();
        }
        validate_shared_binding(binding)?;
    }
    Ok(())
}

fn shared_slot_lifecycle(
    manifest: &RepoPoolManifest,
    slot_id: &str,
) -> (SlotState, Option<String>) {
    let bindings: Vec<_> = manifest
        .bindings
        .iter()
        .filter(|binding| binding.slot_id == slot_id)
        .collect();
    let state = if bindings
        .iter()
        .any(|binding| binding.state == Some(SlotState::Leased))
    {
        SlotState::Leased
    } else if bindings
        .iter()
        .any(|binding| binding.state == Some(SlotState::Starting))
    {
        SlotState::Starting
    } else {
        SlotState::Retained
    };
    let token = if state == SlotState::Starting {
        bindings
            .iter()
            .find_map(|binding| binding.spawn_claim_token.clone())
    } else {
        None
    };
    (state, token)
}

fn validate_shared_slot(manifest: &RepoPoolManifest, slot: &SlotRecord) -> Result<(), PoolError> {
    if manifest
        .bindings
        .iter()
        .any(|binding| binding.slot_id == slot.slot_id && binding.state.is_some())
        && matches!(
            slot.state,
            SlotState::Starting | SlotState::Leased | SlotState::Retained
        )
        && shared_slot_lifecycle(manifest, &slot.slot_id)
            != (slot.state, slot.spawn_claim_token.clone())
    {
        return Err(PoolError::new(
            PoolErrorCode::InvalidBinding,
            "shared slot lifecycle disagrees with sessions",
        ));
    }
    Ok(())
}

fn refresh_shared_slot(manifest: &mut RepoPoolManifest, slot_id: &str) -> Result<(), PoolError> {
    let (state, token) = shared_slot_lifecycle(manifest, slot_id);
    let slot = manifest
        .slots
        .get_mut(slot_id)
        .ok_or_else(|| PoolError::new(PoolErrorCode::InvalidSlotId, "shared slot missing"))?;
    slot.state = state;
    slot.spawn_claim_token = token;
    slot.updated_at = now_rfc3339();
    slot.quarantine_code = None;
    Ok(())
}

fn update_shared_binding(
    manifest: &mut RepoPoolManifest,
    request: &LeaseRequest,
    state: SlotState,
    token: Option<String>,
) -> Result<bool, PoolError> {
    let exact = find_exact_binding(manifest, request)?.authority();
    let idx = find_exact_authority_index(manifest, &exact)?;
    if manifest.bindings[idx].state.is_none() {
        return Ok(false);
    }
    let slot_id = manifest.bindings[idx].slot_id.clone();
    let slot = manifest
        .slots
        .get(&slot_id)
        .ok_or_else(|| PoolError::new(PoolErrorCode::InvalidSlotId, "shared slot missing"))?;
    if !matches!(
        slot.state,
        SlotState::Starting | SlotState::Leased | SlotState::Retained
    ) {
        return Err(PoolError::new(
            PoolErrorCode::InvalidBinding,
            "shared slot is unavailable",
        ));
    }
    manifest.bindings[idx].state = Some(state);
    manifest.bindings[idx].spawn_claim_token = token;
    refresh_shared_slot(manifest, &slot_id)?;
    Ok(true)
}

fn release_shared_binding(
    layout: &RepoPoolLayout,
    request: &LeaseRequest,
    require_retained: bool,
) -> Result<bool, PoolError> {
    let Some(mut manifest) = load_for_update(layout)? else {
        return Ok(false);
    };
    let Ok(binding) = find_exact_binding(&manifest, request).cloned() else {
        return Ok(false);
    };
    if manifest
        .bindings
        .iter()
        .filter(|peer| peer.slot_id == binding.slot_id)
        .count()
        < 2
    {
        return Ok(false);
    }
    if require_retained && binding.state != Some(SlotState::Retained) {
        return Err(PoolError::new(
            PoolErrorCode::InvalidBinding,
            "shared return requires retained session",
        ));
    }
    let slot_id = binding.slot_id.clone();
    manifest
        .bindings
        .retain(|peer| !binding_record_matches_authority(peer, &binding.authority()));
    manifest
        .slots
        .get_mut(&slot_id)
        .unwrap()
        .last_returned_binding = Some(binding);
    refresh_shared_slot(&mut manifest, &slot_id)?;
    save_manifest_at(layout.pool_root(), &manifest)?;
    Ok(true)
}

/// Recover pre-upgrade handoffs which replaced the predecessor's local binding.
/// Hub names the current holder; the old Instance resumes its own session in
/// that exact checkout, without stopping or rebinding the holder.
pub async fn resume_handoff_lease_at(
    layout: &RepoPoolLayout,
    base_repo: &Path,
    source_session: &str,
    source_instance: &str,
    slot_id: &str,
    request: &LeaseRequest,
) -> Result<LeaseResult, PoolError> {
    validate_request(request)?;
    let _guard = acquire_pool_guard(layout).await?;
    let mut manifest = load_for_update(layout)?
        .ok_or_else(|| PoolError::new(PoolErrorCode::ManifestCorrupt, "pool manifest missing"))?;
    let existing = manifest
        .bindings
        .iter()
        .position(|binding| binding.session_key == request.session_key);
    let slot = manifest
        .slots
        .get(slot_id)
        .ok_or_else(|| PoolError::new(PoolErrorCode::InvalidSlotId, "handoff slot missing"))?;
    if !matches!(
        slot.state,
        SlotState::Starting | SlotState::Leased | SlotState::Retained
    ) {
        return Err(PoolError::new(
            PoolErrorCode::InvalidBinding,
            "handoff directory is not ready",
        ));
    }
    if existing.is_none()
        && !manifest.bindings.iter().any(|binding| {
            binding.session_key == source_session
                && binding.instance_id == source_instance
                && binding.slot_id == slot_id
        })
    {
        return Err(PoolError::new(
            PoolErrorCode::InvalidBinding,
            "handoff directory holder changed",
        ));
    }
    let identity = canonical_repo_identity(&manifest.canonical_repo_identity)?;
    let slot_id = SlotId::parse(slot_id)?;
    let path = layout.slot_path(&slot_id)?;
    verify_base_matches_identity(base_repo, &identity).await?;
    verify_pool_worktree_ownership(layout, base_repo, &path, &slot_id).await?;
    let base_ref = slot.last_base_ref.clone().ok_or_else(|| {
        PoolError::new(PoolErrorCode::ManifestCorrupt, "handoff slot has no base")
    })?;
    make_slot_shared(&mut manifest, slot_id.as_str())?;
    if let Some(idx) = existing {
        let binding = &manifest.bindings[idx];
        if binding.instance_id != request.instance_id
            || binding.slot_id != slot_id.as_str()
            || binding.state != Some(SlotState::Retained)
        {
            return Err(PoolError::new(
                PoolErrorCode::InvalidBinding,
                "reborn session binding changed",
            ));
        }
    }
    let token = fresh_spawn_claim_token();
    let mut next = BindingRecord::for_lease(&slot_id, request);
    next.state = Some(SlotState::Starting);
    next.spawn_claim_token = Some(token.clone());
    if let Some(idx) = existing {
        manifest.bindings[idx] = next;
    } else {
        manifest.bindings.push(next);
    }
    refresh_shared_slot(&mut manifest, slot_id.as_str())?;
    save_manifest_at(layout.pool_root(), &manifest)?;
    Ok(LeaseResult {
        slot_id,
        worktree_path: path,
        base_ref,
        reused_available: false,
        spawn_claim_token: token,
        baseline: None,
    })
}
