// --- checkouts a running Agent asks for ---
//
// A Run starts in its own private directory; when its work needs a repository
// it asks for a checkout (`xmatrix repo checkout`). The checkout is a slot of
// the same repo-key pool a `repo:` launch leases, bound to the Run's session,
// so it follows the same S1/L1 rules: natural exit retains it, the session's
// next Run takes it back, and abandoning the Instance returns it.

/// How a checkout request was answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckoutOutcome {
    /// This Run already holds the slot.
    Held,
    /// The session's retained slot was taken back by its next Run.
    Reborn,
    /// The session's reclaimed slot was recreated at its recorded path.
    Rehydrated,
    /// An idle slot was reset onto the fresh base.
    Reused,
    /// A new slot was checked out.
    Created,
}

impl CheckoutOutcome {
    pub fn label(self) -> &'static str {
        match self {
            Self::Held => "held",
            Self::Reborn => "reborn",
            Self::Rehydrated => "rehydrated",
            Self::Reused => "reused",
            Self::Created => "created",
        }
    }
}

#[derive(Debug, Clone)]
pub struct CheckoutResult {
    pub slot_id: SlotId,
    pub worktree_path: PathBuf,
    pub outcome: CheckoutOutcome,
}

/// Bind this pool's slot for `request`'s session to `request`'s Run and leave
/// it Leased. One session holds at most one slot per repository: asking again
/// answers with the slot it already holds.
pub async fn checkout_for_session_at(
    layout: &RepoPoolLayout,
    base_repo: &Path,
    canonical_repo: &str,
    request: &LeaseRequest,
) -> Result<CheckoutResult, PoolError> {
    validate_request(request)?;
    if let Some(slot_id) = exact_bound_slot_for_request_at(layout, request).await? {
        let worktree_path = layout.slot_path(&slot_id)?;
        if !is_formal_linked_worktree(&worktree_path) {
            return Err(PoolError::new(
                PoolErrorCode::WorktreeMissing,
                "this Run's checkout is missing",
            ));
        }
        return Ok(CheckoutResult { slot_id, worktree_path, outcome: CheckoutOutcome::Held });
    }
    let session_bound = {
        let _guard = acquire_pool_guard(layout).await?;
        load_for_update(layout)?.is_some_and(|manifest| {
            manifest
                .bindings
                .iter()
                .any(|binding| binding.session_key == request.session_key)
        })
    };
    let (lease, outcome) = if session_bound {
        record_lost_retained_checkout_at(layout, base_repo, &request.session_key).await?;
        match rehydrate_record_for_session_at(layout, &request.session_key).await? {
            Some(record) => (
                rehydrate_retained_lease_at(layout, base_repo, &record, request).await?,
                CheckoutOutcome::Rehydrated,
            ),
            None => {
                let retained = retained_binding_for_session_at(layout, &request.session_key).await?;
                (
                    rebind_retained_lease_at(layout, base_repo, &retained.authority, request).await?,
                    CheckoutOutcome::Reborn,
                )
            }
        }
    } else if let Some(record) = rehydrate_record_for_session_at(layout, &request.session_key).await? {
        (
            rehydrate_retained_lease_at(layout, base_repo, &record, request).await?,
            CheckoutOutcome::Rehydrated,
        )
    } else {
        let lease = lease_available_or_create_at(layout, base_repo, canonical_repo, request).await?;
        let outcome = if lease.reused_available { CheckoutOutcome::Reused } else { CheckoutOutcome::Created };
        (lease, outcome)
    };
    // No process starts here: the Run that asked is already running, so the
    // Starting slot is claimed at once.
    let authority = BindingAuthority::new(
        &request.session_key,
        &request.instance_id,
        &request.run_id,
        &request.execution_key,
        lease.slot_id.as_str(),
    );
    claim_starting_lease_at(layout, &authority, &lease.spawn_claim_token, &lease.worktree_path).await?;
    Ok(CheckoutResult { slot_id: lease.slot_id, worktree_path: lease.worktree_path, outcome })
}

/// Every binding this machine's pools hold that `wanted` selects, with the
/// pool that holds it. Pools that cannot be read are skipped: this answers
/// "what else does this Run or session hold", never "is the pool sound".
pub async fn bindings_where_at(
    pools_root: &Path,
    wanted: impl Fn(&BindingAuthority) -> bool,
) -> Vec<(RepoPoolLayout, BindingAuthority)> {
    let mut found = Vec::new();
    for layout in pool_layouts_at(pools_root) {
        let held: Vec<BindingAuthority> = {
            let Ok(_guard) = acquire_pool_guard(&layout).await else {
                continue;
            };
            let Ok(Some(manifest)) = load_manifest_at(layout.pool_root()) else {
                continue;
            };
            manifest.bindings.iter().map(BindingRecord::authority).filter(|authority| wanted(authority)).collect()
        };
        found.extend(held.into_iter().map(|authority| (layout.clone(), authority)));
    }
    found
}
