// Which pool directory a session's layout resolves to while a legacy
// 64-hex pool and the compact pool for one repository sit side by side.

/// Which pool directory a layout resolves to while a legacy 64-hex pool for
/// the same repository still exists beside the compact 8-hex one.
#[derive(Debug, Clone, Copy)]
enum LegacyPoolUse<'a> {
    /// The legacy directory whenever it exists: the sweep, and callers that
    /// hold no session to tell the two pools apart.
    WhenPresent,
    /// The legacy directory only while it still holds one of these sessions
    /// (a binding or a rehydrate record) or this slot; a new session goes to
    /// the compact pool.
    Holding {
        sessions: &'a [&'a str],
        slot: Option<&'a str>,
    },
    /// Never the legacy directory: work that starts no session there.
    Never,
}

impl RepoPoolLayout {
    /// The pool that holds any of `session_keys` (a session and, for a
    /// handoff, its predecessor), or the compact pool for sessions it has none
    /// of. A legacy pool keeps only the sessions it already has: its 64-hex
    /// repo, `slots` and 32-hex slot components add 88 characters to every
    /// path in the checkout, which on Windows pushes a deep dependency tree
    /// past MAX_PATH (260), where processes in it can no longer start.
    pub fn for_session(
        trusted_pools_root: &Path,
        repo_key: RepoKeyId,
        session_keys: &[&str],
    ) -> Result<Self, PoolError> {
        Self::resolve(
            trusted_pools_root,
            repo_key,
            LegacyPoolUse::Holding {
                sessions: session_keys,
                slot: None,
            },
        )
    }

    /// The pool new sessions start in: always the compact one.
    pub fn for_new_sessions(
        trusted_pools_root: &Path,
        repo_key: RepoKeyId,
    ) -> Result<Self, PoolError> {
        Self::resolve(trusted_pools_root, repo_key, LegacyPoolUse::Never)
    }

    /// The pool holding a persisted lease: the one with its slot or its
    /// session (see [`Self::for_session`]).
    pub fn from_persisted_lease(
        trusted_pools_root: &Path,
        repo_key_id: &str,
        session_key: Option<&str>,
        slot_id: &str,
    ) -> Result<Self, PoolError> {
        let sessions: Vec<&str> = session_key.into_iter().collect();
        Self::resolve(
            trusted_pools_root,
            RepoKeyId::parse_hex64(repo_key_id)?,
            LegacyPoolUse::Holding {
                sessions: &sessions,
                slot: Some(slot_id),
            },
        )
    }
}

/// Whether a legacy pool still holds one of `session_keys` (a binding in its
/// manifest or a rehydrate record) or the slot `slot_id` (its record carries
/// the slot's return receipt). Anything unreadable counts as holding it, so
/// a session whose state cannot be read is never sent to a new tree.
fn legacy_pool_holds(
    trusted: &Path,
    repo_key: &RepoKeyId,
    legacy: &Path,
    session_keys: &[&str],
    slot_id: Option<&str>,
) -> bool {
    let held = |key: &str| session_keys.contains(&key);
    let bound = match load_manifest_at(legacy) {
        Ok(Some(manifest)) => {
            slot_id.is_some_and(|slot| manifest.slots.contains_key(slot))
                || manifest
                    .bindings
                    .iter()
                    .any(|binding| held(&binding.session_key))
        }
        Ok(None) => false,
        Err(_) => return true,
    };
    if bound {
        return true;
    }
    let layout = RepoPoolLayout {
        trusted_pools_root: trusted.to_path_buf(),
        repo_key: repo_key.clone(),
        pool_root: legacy.to_path_buf(),
    };
    match load_rehydrate_records(&layout) {
        Ok(records) => records.iter().any(|record| held(&record.session_key)),
        Err(_) => true,
    }
}
