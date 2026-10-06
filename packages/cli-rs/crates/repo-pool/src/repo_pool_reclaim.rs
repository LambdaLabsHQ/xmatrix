// --- liveness-aware slot reclamation ---
//
// Every lease transition in the manifest assumes the run that took it will
// hand it back through one typed stop. A daemon restart, crash, or self-update
// never reaches that stop, so the slot stays `Leased` forever: it is invisible
// to `pick_idle_pool_slot` (which only offers Available/Retained) and to
// eviction (which only removed Available). New sessions then mint fresh slots
// beside the stranded ones, and a repo pool grows without bound.
//
// The fix is to stop trusting the recorded state on its own and verify the
// writer is still there. Two passes, both driven by that check:
//
//   1. Demote a stranded `Starting`/`Leased` slot to `Retained` — the state a
//      clean stop with the default Retain disposition would have produced.
//      The tree is never touched here, so this is cheap and lossless: reuse
//      still runs `snapshot_if_needed`, so un-landed work is preserved.
//   2. Evict idle slots beyond the warm-cache budget, which is what actually
//      returns disk.

/// How many idle slots a repo pool keeps warm for reuse.
pub const REPO_POOL_IDLE_KEEP_ENV: &str = "XMATRIX_REPO_POOL_IDLE_KEEP";
/// How long a stranded lease must sit before liveness is trusted to demote it.
pub const REPO_POOL_ORPHAN_MIN_AGE_SECS_ENV: &str = "XMATRIX_REPO_POOL_ORPHAN_MIN_AGE_SECS";
/// How long a slot tree must sit untouched before its disk may be taken.
pub const REPO_POOL_EVICT_MIN_IDLE_SECS_ENV: &str = "XMATRIX_REPO_POOL_EVICT_MIN_IDLE_SECS";
/// How long a resting session's tree must sit untouched before the sweep may
/// reclaim it behind a rehydrate record (docs/instance-sleep.md §6).
pub const REPO_POOL_RESTING_EVICT_SECS_ENV: &str = "XMATRIX_REPO_POOL_RESTING_EVICT_SECS";

/// A slot is a full checkout plus whatever the build leaves behind — `target/`
/// and `node_modules/` survive the `git clean -ffd` on reuse by design — so a
/// warm slot is gigabytes, not megabytes. Keep a handful, not a generation.
const DEFAULT_IDLE_KEEP: usize = 4;
/// A lease is recorded before the daemon writes its run-registry row. Within
/// that window a live run looks stranded, so never demote a young lease: the
/// cost of waiting is a spare slot, the cost of being wrong is `reset --hard`
/// under a running agent.
const DEFAULT_ORPHAN_MIN_AGE: Duration = Duration::from_secs(60 * 60);
/// Matches the run-worktree GC's floor for an unrecognized linked tree. Taking
/// a slot's disk is the one irreversible step here, so it also wants the one
/// piece of evidence that does not depend on any bookkeeping being correct.
const DEFAULT_EVICT_MIN_IDLE: Duration = Duration::from_secs(7 * 24 * 60 * 60);

fn idle_keep_count() -> usize {
    std::env::var(REPO_POOL_IDLE_KEEP_ENV)
        .ok()
        .and_then(|raw| raw.trim().parse::<usize>().ok())
        .unwrap_or(DEFAULT_IDLE_KEEP)
}

fn orphan_min_age() -> Duration {
    env_duration(REPO_POOL_ORPHAN_MIN_AGE_SECS_ENV).unwrap_or(DEFAULT_ORPHAN_MIN_AGE)
}

fn evict_min_idle() -> Duration {
    env_duration(REPO_POOL_EVICT_MIN_IDLE_SECS_ENV).unwrap_or(DEFAULT_EVICT_MIN_IDLE)
}

/// A resting Instance usually wakes within hours if at all. After this its
/// checkout is recorded and its disk returned; a later wake rebuilds only the
/// ignored build output.
const DEFAULT_RESTING_EVICT_MIN_IDLE: Duration = Duration::from_secs(3 * 60 * 60);
/// Under disk pressure a resting tree still gets this long to be woken back
/// into place before its disk is taken.
const PRESSURE_RESTING_EVICT_MIN_IDLE: Duration = Duration::from_secs(10 * 60);

fn resting_evict_min_idle(keep_idle: usize) -> Duration {
    env_duration(REPO_POOL_RESTING_EVICT_SECS_ENV).unwrap_or(if keep_idle == 0 {
        PRESSURE_RESTING_EVICT_MIN_IDLE
    } else {
        DEFAULT_RESTING_EVICT_MIN_IDLE
    })
}

fn env_duration(name: &str) -> Option<Duration> {
    std::env::var(name)
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .map(Duration::from_secs)
}

/// How long nothing has touched a slot tree, or `None` when that cannot be
/// read. The daemon run registry is the obvious liveness source and the one
/// that cannot be relied on alone: it is rebuilt from sidecars, so it routinely
/// names dead processes, and it can be empty while agents are working. The
/// filesystem does not lie about that, so every destructive step also asks it.
///
/// Bounded on purpose — one `read_dir` of the slot root plus the worktree's
/// index. A working agent touches at least one of them long before this floor.
fn slot_idle_for(path: &Path) -> Option<Duration> {
    let mut newest = std::fs::metadata(path).ok()?.modified().ok()?;
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            if let Ok(modified) = entry.metadata().and_then(|meta| meta.modified()) {
                newest = newest.max(modified);
            }
        }
    }
    if let Some(index) = worktree_index_path(path)
        && let Ok(modified) = std::fs::metadata(index).and_then(|meta| meta.modified())
    {
        newest = newest.max(modified);
    }
    std::time::SystemTime::now().duration_since(newest).ok()
}

/// A linked worktree's `.git` is a file pointing at its admin directory, where
/// git stamps `index` on every staging or checkout operation.
fn worktree_index_path(path: &Path) -> Option<PathBuf> {
    let pointer = std::fs::read_to_string(path.join(".git")).ok()?;
    let admin = pointer.trim().strip_prefix("gitdir:")?.trim();
    Some(Path::new(admin).join("index"))
}

#[derive(Debug, Default, Clone)]
pub(crate) struct PoolReclaimOutcome {
    /// Stranded leases returned to the reusable pool.
    pub demoted: Vec<String>,
    /// Slot trees removed from disk.
    pub evicted: Vec<String>,
    /// Manifest records whose slot directory was already gone.
    pub pruned: Vec<String>,
}

impl PoolReclaimOutcome {
    fn is_empty(&self) -> bool {
        self.demoted.is_empty() && self.evicted.is_empty() && self.pruned.is_empty()
    }

    fn absorb(&mut self, other: PoolReclaimOutcome) {
        self.demoted.extend(other.demoted);
        self.evicted.extend(other.evicted);
        self.pruned.extend(other.pruned);
    }
}

/// What this machine still has a writer for. A slot counts as live when the
/// run registry names it with a process that is still running, or when any
/// live run's cwd sits inside its tree. Both are required: a rehydrated
/// registry row can name a dead pid, and a run may have been launched into a
/// slot directory without the binding surviving a restart.
#[derive(Debug, Default)]
pub struct PoolLiveness {
    pub slot_ids: BTreeSet<String>,
    pub cwds: BTreeSet<PathBuf>,
}

impl PoolLiveness {
    fn claims(&self, slot_id: &str, slot_path: &Path) -> bool {
        if self.slot_ids.contains(slot_id) {
            return true;
        }
        let canonical = slot_path
            .canonicalize()
            .unwrap_or_else(|_| slot_path.to_path_buf());
        self.cwds.iter().any(|cwd| {
            let cwd = cwd.canonicalize().unwrap_or_else(|_| cwd.clone());
            cwd.starts_with(&canonical)
        })
    }
}

/// Pools under `pools_root`, each validated against its own persisted repo
/// key so a stray directory can never be swept as if it were a pool.
fn pool_layouts_at(pools_root: &Path) -> Vec<RepoPoolLayout> {
    let Ok(entries) = std::fs::read_dir(pools_root) else {
        return Vec::new();
    };
    let mut layouts = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.join(MANIFEST_FILE).is_file() {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let key = if name.len() == POOL_DIR_KEY_CHARS {
            let Ok(key) = read_compact_pool_key(&path) else {
                continue;
            };
            if !key.as_str().starts_with(&name) {
                continue;
            }
            key
        } else {
            let Ok(key) = RepoKeyId::parse_hex64(&name) else {
                continue;
            };
            key
        };
        let Ok(layout) = RepoPoolLayout::from_persisted(pools_root, key.as_str()) else {
            continue;
        };
        if layout.pool_root().file_name() != Some(entry.file_name().as_os_str()) {
            continue;
        }
        layouts.push(layout);
    }
    layouts
}

/// Age of a slot record, or `None` when its timestamp is unreadable. An
/// unreadable timestamp is treated as too young to touch.
fn slot_age(slot: &SlotRecord, now: time::OffsetDateTime) -> Option<Duration> {
    let updated = time::OffsetDateTime::parse(
        &slot.updated_at,
        &time::format_description::well_known::Rfc3339,
    )
    .ok()?;
    Duration::try_from(now - updated).ok()
}

/// Return stranded leases to the reusable pool. Only the manifest changes.
fn demote_orphaned_leases(
    layout: &RepoPoolLayout,
    manifest: &mut RepoPoolManifest,
    live: &PoolLiveness,
) -> Vec<String> {
    let now = time::OffsetDateTime::now_utc();
    let min_age = orphan_min_age();
    let ids: Vec<String> = manifest.slots.keys().cloned().collect();
    let mut demoted = Vec::new();
    for id in ids {
        let Some(slot) = manifest.slots.get(&id) else {
            continue;
        };
        if !matches!(slot.state, SlotState::Starting | SlotState::Leased) {
            continue;
        }
        if slot_age(slot, now).is_none_or(|age| age < min_age) {
            continue;
        }
        let Ok(path) = layout.slot_path_for_id(&id) else {
            continue;
        };
        if live.claims(&id, &path) {
            continue;
        }
        if slot_idle_for(&path).is_none_or(|idle| idle < min_age) {
            continue;
        }
        let Some(slot) = manifest.slots.get_mut(&id) else {
            continue;
        };
        slot.state = SlotState::Retained;
        slot.spawn_claim_token = None;
        slot.quarantine_code = None;
        // Deliberately not stamped. Every other transition records when a run
        // touched the slot, and both the eviction budget and `pick_idle_pool_slot`
        // read that as recency. Stamping a correction would make the most
        // stranded slots look like the freshest ones and send the budget after
        // genuinely warm trees instead.
        demoted.push(id);
    }
    demoted
}

/// Resting sessions whose checkout vanished behind the pool: each becomes a
/// rehydrate record, so its next reborn recreates the tree in place. A slot
/// that cannot be recorded is kept for a later sweep.
async fn record_lost_checkouts(
    layout: &RepoPoolLayout,
    manifest: &mut RepoPoolManifest,
    live: &PoolLiveness,
) -> Vec<String> {
    let Some(base_repo) = lost_checkout_base(manifest, None) else {
        return Vec::new();
    };
    let ids: Vec<String> = manifest
        .bindings
        .iter()
        .map(|binding| binding.slot_id.clone())
        .collect();
    let mut recorded = Vec::new();
    for id in ids {
        let Ok(path) = layout.slot_path_for_id(&id) else {
            continue;
        };
        if path.join(".git").is_file() || live.claims(&id, &path) {
            continue;
        }
        match record_lost_checkout(layout, &base_repo, manifest, &id).await {
            Ok(true) => recorded.push(id),
            Ok(false) => {}
            Err(error) => eprintln!(
                "repo pool reclaim: keeping lost slot {id}; its session could not be recorded for rehydrate ({error})"
            ),
        }
    }
    recorded
}

/// Drop records whose slot directory is gone. The tree is already reclaimed;
/// the record only keeps a dead id in the manifest and its binding alive. A
/// resting session's slot is left to `record_lost_checkouts`.
fn prune_missing_slot_dirs(
    layout: &RepoPoolLayout,
    manifest: &mut RepoPoolManifest,
    live: &PoolLiveness,
) -> Vec<String> {
    let ids: Vec<String> = manifest.slots.keys().cloned().collect();
    let mut pruned = Vec::new();
    for id in ids {
        let Ok(path) = layout.slot_path_for_id(&id) else {
            continue;
        };
        let resting = manifest.slots.get(&id).is_some_and(|slot| {
            slot.state == SlotState::Retained
                && manifest
                    .bindings
                    .iter()
                    .any(|binding| binding.slot_id == id)
        });
        if resting || path.exists() || live.claims(&id, &path) {
            continue;
        }
        manifest.slots.remove(&id);
        manifest.bindings.retain(|binding| binding.slot_id != id);
        pruned.push(id);
    }
    pruned
}

/// Slots that may be removed, worst first: quarantined trees are never offered
/// to a session again, so they go before any reusable slot is given up. The
/// remaining idle slots are ordered oldest-first and the newest `keep_idle`
/// are spared, so a session that comes back soon still finds a warm tree.
fn eviction_candidates(
    layout: &RepoPoolLayout,
    manifest: &RepoPoolManifest,
    live: &PoolLiveness,
    keep_idle: usize,
) -> Vec<String> {
    let mut quarantined: Vec<(String, String)> = Vec::new();
    let mut idle: Vec<(String, String)> = Vec::new();
    // A resting session's tree is reclaimed on its own clock, outside the warm
    // budget: nobody else may reuse it, and its rehydrate record keeps the
    // session wakeable (docs/instance-sleep.md §6).
    let resting_floor = resting_evict_min_idle(keep_idle);
    let mut resting: Vec<String> = Vec::new();
    for (id, slot) in &manifest.slots {
        let Ok(path) = layout.slot_path_for_id(id) else {
            continue;
        };
        if live.claims(id, &path) {
            continue;
        }
        let bound = manifest
            .bindings
            .iter()
            .any(|binding| &binding.slot_id == id);
        match slot.state {
            SlotState::Quarantined => quarantined.push((id.clone(), slot.updated_at.clone())),
            SlotState::Retained
                if bound
                    && path.join(".git").is_file()
                    && slot_idle_for(&path).is_some_and(|idle| idle >= resting_floor) =>
            {
                resting.push(id.clone())
            }
            SlotState::Available | SlotState::Retained => {
                idle.push((id.clone(), slot.updated_at.clone()))
            }
            // Starting/Leased still claim a writer; Preparing/Returning are
            // crash intermediates that `reconcile_intermediate_states` owns.
            _ => {}
        }
    }
    let sort_oldest_first = |pool: &mut Vec<(String, String)>| {
        pool.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(&b.0)));
    };
    sort_oldest_first(&mut quarantined);
    sort_oldest_first(&mut idle);
    // The budget is applied to the whole reusable set, then activity vetoes
    // individual removals. Doing it the other way round would let a pool full
    // of busy slots spend the budget on the few that happen to be quiet.
    let surplus = idle.len().saturating_sub(keep_idle);
    let min_idle = evict_min_idle();
    let budgeted: Vec<String> = quarantined
        .into_iter()
        .chain(idle.into_iter().take(surplus))
        .map(|(id, _)| id)
        .filter(|id| {
            // Removing the tree is the only step here that cannot be undone, so
            // it needs evidence no bookkeeping can contradict.
            layout.slot_path_for_id(id).ok().is_some_and(|path| {
                !path.exists() || slot_idle_for(&path).is_some_and(|idle| idle >= min_idle)
            })
        })
        .collect();
    resting.sort();
    resting.into_iter().chain(budgeted).collect()
}

async fn reclaim_pool_slots_one(
    layout: &RepoPoolLayout,
    live: &PoolLiveness,
    keep_idle: usize,
) -> Result<PoolReclaimOutcome, PoolError> {
    let _guard = acquire_pool_guard(layout).await?;
    let Some(mut manifest) = load_for_update(layout)? else {
        return Ok(PoolReclaimOutcome::default());
    };
    let mut pruned = record_lost_checkouts(layout, &mut manifest, live).await;
    pruned.extend(prune_missing_slot_dirs(layout, &mut manifest, live));
    let mut outcome = PoolReclaimOutcome {
        pruned,
        demoted: demote_orphaned_leases(layout, &mut manifest, live),
        evicted: Vec::new(),
    };
    // A lease demoted by this sweep is a bookkeeping correction, not rest:
    // its tree is left alone until a later sweep finds it still untouched.
    let demoted_now: BTreeSet<String> = outcome.demoted.iter().cloned().collect();
    for slot_id in eviction_candidates(layout, &manifest, live, keep_idle)
        .into_iter()
        .filter(|slot_id| !demoted_now.contains(slot_id))
    {
        let parsed = SlotId::parse(&slot_id)?;
        let worktree = layout.slot_path(&parsed)?;
        if worktree.exists() {
            // Eviction used to be reachable only for Available slots, which had
            // just been reset onto origin, so removal could be unconditional.
            // Retained and Quarantined trees hold whatever a real session left
            // behind, and `git worktree remove --force` would discard it, so
            // pin it to `refs/xmatrix/snapshot/<slotId>/<uuid>` in the shared
            // repository first. Fail closed: a slot whose work cannot be
            // preserved keeps its disk.
            if linked_repository_is_gone(&worktree) {
                // Its repository (often another user's clone) no longer
                // exists, so no snapshot can ever succeed. Keep the files,
                // outside the pool, and stop retrying every sweep.
                if let Err(error) = archive_orphaned_slot(layout, &worktree, &slot_id) {
                    eprintln!(
                        "repo pool reclaim: keeping slot {slot_id}; its repository is gone and it could not be archived ({error})"
                    );
                    continue;
                }
            } else {
                let snapshot = match snapshot_if_needed(&worktree, &slot_id).await {
                    Ok(snapshot) => snapshot,
                    Err(error) => {
                        eprintln!(
                            "repo pool reclaim: keeping slot {slot_id}; un-landed work could not be preserved ({error})"
                        );
                        continue;
                    }
                };
                // A bound session can still wake: write down its checkout before
                // the tree goes, or keep the tree.
                let binding = manifest
                    .bindings
                    .iter()
                    .find(|binding| binding.slot_id == slot_id)
                    .cloned();
                if let (Some(binding), Some(slot)) = (binding, manifest.slots.get(&slot_id)) {
                    let recorded =
                        match capture_rehydrate_record(&worktree, &binding, slot, snapshot).await {
                            Ok(record) => load_rehydrate_records(layout).and_then(|mut records| {
                                remember_rehydrate_record(&mut records, record);
                                save_rehydrate_records(layout, &records)
                            }),
                            Err(error) => Err(error),
                        };
                    if let Err(error) = recorded {
                        eprintln!(
                            "repo pool reclaim: keeping slot {slot_id}; its session could not be recorded for rehydrate ({error})"
                        );
                        continue;
                    }
                }
                let base_repo = registered_base_repo_for_worktree(&worktree).await?;
                // Honors foreign worktree locks.
                try_safe_remove_created_worktree(layout, &base_repo, &worktree, &parsed).await?;
            }
        }
        manifest.slots.remove(&slot_id);
        manifest
            .bindings
            .retain(|binding| binding.slot_id != slot_id);
        outcome.evicted.push(slot_id);
    }
    if !outcome.is_empty() {
        save_manifest_at(layout.pool_root(), &manifest)?;
    }
    Ok(outcome)
}

/// Where reclaim moves trees whose repository no longer exists.
const ORPHANED_DIR: &str = "orphaned";

/// A linked tree whose `.git` names an admin directory that is gone (its
/// repository was deleted or belongs to another account's clone).
fn linked_repository_is_gone(worktree: &Path) -> bool {
    read_linked_worktree_admin_pointer(worktree).is_ok_and(|admin| !admin.exists())
}

fn archive_orphaned_slot(
    layout: &RepoPoolLayout,
    worktree: &Path,
    slot_id: &str,
) -> Result<(), PoolError> {
    let archive = layout.pool_root().join(ORPHANED_DIR);
    create_component_dir_checked(layout.trusted_pools_root(), &archive)?;
    std::fs::rename(worktree, archive.join(slot_id))
        .map_err(|_| PoolError::new(PoolErrorCode::Io, "archive orphaned slot failed"))
}

pub(crate) async fn reclaim_pool_slots_at(
    pools_root: &Path,
    live: &PoolLiveness,
    keep_idle: usize,
) -> PoolReclaimOutcome {
    let mut outcome = PoolReclaimOutcome::default();
    for layout in pool_layouts_at(pools_root) {
        match reclaim_pool_slots_one(&layout, live, keep_idle).await {
            Ok(one) => outcome.absorb(one),
            Err(error) => eprintln!(
                "repo pool reclaim: skipped pool {}: {error}",
                layout.repo_key().as_str()
            ),
        }
    }
    outcome
}

/// Sweep every pool under the default root. `keep_idle` is the warm-cache
/// budget; pass 0 to give up the cache entirely under disk pressure.
pub(crate) async fn reclaim_pool_slots(
    live: &PoolLiveness,
    keep_idle: usize,
) -> PoolReclaimOutcome {
    let Ok(root) = default_repo_pools_root() else {
        return PoolReclaimOutcome::default();
    };
    reclaim_pool_slots_at(&root, live, keep_idle).await
}

/// The warm-cache budget a routine sweep should use.
pub(crate) fn default_idle_keep() -> usize {
    idle_keep_count()
}

pub(crate) fn log_pool_reclaim_outcome(outcome: &PoolReclaimOutcome) {
    if outcome.is_empty() {
        return;
    }
    eprintln!(
        "repo pool reclaim: returned {:?} stranded lease(s), evicted {:?}, pruned {:?} missing record(s)",
        outcome.demoted, outcome.evicted, outcome.pruned
    );
}
