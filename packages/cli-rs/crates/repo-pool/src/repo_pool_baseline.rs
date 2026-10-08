/// Presentation evidence for the recorded checkout base. Never execution authority.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryBaseline {
    pub base_ref: String,
    pub base_oid: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirmed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history_rewritten: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote: Option<ConfirmedRemoteBase>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relationship: Option<BaseRelationship>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notice_key: Option<String>,
    #[serde(skip)]
    pub warn_agent: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmedRemoteBase {
    pub base_ref: String,
    pub base_oid: String,
    pub confirmed_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BaseRelationship {
    Ancestor,
    Diverged,
    Unknown,
}

impl ResolvedBase {
    fn baseline(&self) -> RepositoryBaseline {
        RepositoryBaseline {
            base_ref: self.base_ref.clone(),
            base_oid: self.oid.clone(),
            confirmed_at: Some(self.confirmed_at.clone()),
            history_rewritten: self.history_rewritten,
            remote: None,
            relationship: None,
            notice_key: None,
            warn_agent: false,
        }
    }
}

// Kept outside the v1 manifest: older daemons must keep reading every lease.
// Records are bounded by the pool's live slots and retained rehydrate records.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BaselineReceipt {
    slot_id: String,
    task_key: String,
    baseline: RepositoryBaseline,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    warning_run_id: Option<String>,
}

const BASELINE_RECEIPTS_FILE: &str = "baseline-evidence.json";
const MAX_BASELINE_RECEIPTS: usize = 512;

fn load_baseline_receipts(layout: &RepoPoolLayout) -> Result<Vec<BaselineReceipt>, PoolError> {
    let path = layout.pool_root().join(BASELINE_RECEIPTS_FILE);
    let Some(raw) = read_private_pool_record(&path, "baseline evidence")? else {
        return Ok(Vec::new());
    };
    let records: Vec<BaselineReceipt> = serde_json::from_slice(&raw)
        .map_err(|_| PoolError::new(PoolErrorCode::ManifestCorrupt, "invalid baseline evidence"))?;
    if records.len() > MAX_BASELINE_RECEIPTS {
        return Err(PoolError::new(
            PoolErrorCode::ManifestCorrupt,
            "too many baseline receipts",
        ));
    }
    for record in &records {
        SlotId::parse(&record.slot_id)?;
        validate_binding_field("sessionKey", &record.task_key)?;
        validate_base_ref(&record.baseline.base_ref)?;
        validate_oid(&record.baseline.base_oid)?;
        if record.baseline.remote.is_some()
            || record.baseline.relationship.is_some()
            || record.baseline.notice_key.is_some()
        {
            return Err(PoolError::new(
                PoolErrorCode::ManifestCorrupt,
                "baseline receipt contains transient evidence",
            ));
        }
        if let Some(at) = &record.baseline.confirmed_at {
            validate_updated_at(at)?;
        }
        if let Some(run) = &record.warning_run_id {
            validate_binding_field("runId", run)?;
        }
    }
    Ok(records)
}

fn save_baseline_receipts(
    layout: &RepoPoolLayout,
    records: &[BaselineReceipt],
) -> Result<(), PoolError> {
    if records.len() > MAX_BASELINE_RECEIPTS {
        return Err(PoolError::new(
            PoolErrorCode::Internal,
            "baseline receipt bound exceeded",
        ));
    }
    let path = layout.pool_root().join(BASELINE_RECEIPTS_FILE);
    if let Ok(meta) = std::fs::symlink_metadata(&path) {
        ensure_regular_file_no_reparse(&path, &meta)?;
    }
    let bytes = serde_json::to_vec(records).map_err(|_| {
        PoolError::new(
            PoolErrorCode::Internal,
            "cannot serialize baseline evidence",
        )
    })?;
    let temporary = xmatrix_cli_core::config::unique_temporary_path(&path);
    write_private_pool_record(&temporary, &path, &bytes, "baseline evidence")
}

/// Evidence is read only after exact binding validation. Remote access happens
/// outside the pool guard, and the binding/base is checked again afterwards.
/// A failed remote check preserves an old task and reports Unknown.
pub async fn observe_lease_baseline_at(
    layout: &RepoPoolLayout,
    base_repo: &Path,
    request: &LeaseRequest,
    lease: &LeaseResult,
    continued: bool,
) -> Result<RepositoryBaseline, PoolError> {
    let recorded = {
        let _guard = acquire_pool_guard(layout).await?;
        recorded_lease_base(layout, request, Some(lease.slot_id.as_str()))?
    };
    let fetch_repo = fetch_repo_for_pool(layout, base_repo);
    let remote = if continued {
        tokio::time::timeout(GIT_LOCAL_TIMEOUT, confirm_origin_default_once(&fetch_repo))
            .await
            .ok()
            .and_then(Result::ok)
    } else {
        None
    };
    let relationship = if continued {
        Some(match remote.as_ref() {
            Some(remote) => match tokio::time::timeout(
                GIT_LOCAL_TIMEOUT,
                proven_ancestor(&fetch_repo, &recorded.1, &remote.oid),
            )
            .await
            .unwrap_or(None)
            {
                Some(true) => BaseRelationship::Ancestor,
                Some(false) => BaseRelationship::Diverged,
                None => BaseRelationship::Unknown,
            },
            None => BaseRelationship::Unknown,
        })
    } else {
        None
    };
    let _guard = acquire_pool_guard(layout).await?;
    if recorded_lease_base(layout, request, Some(lease.slot_id.as_str()))? != recorded {
        return Err(PoolError::new(
            PoolErrorCode::InvalidBinding,
            "baseline changed during observation",
        ));
    }
    let mut records = load_baseline_receipts(layout)?;
    let manifest = load_for_update(layout)?
        .ok_or_else(|| PoolError::new(PoolErrorCode::ManifestCorrupt, "pool missing"))?;
    let evicted = load_rehydrate_records(layout)?;
    records.retain(|record| {
        manifest.slots.contains_key(&record.slot_id)
            || evicted.iter().any(|old| old.slot_id == record.slot_id)
    });
    let slot_id = lease.slot_id.as_str();
    let index = records.iter().position(|record| record.slot_id == slot_id);
    let fresh_task = !continued && lease.baseline.is_some();
    let original = index.filter(|_| !fresh_task).and_then(|index| {
        let record = &records[index];
        (record.baseline.base_ref == recorded.0 && record.baseline.base_oid == recorded.1)
            .then(|| record.clone())
    });
    let baseline = lease
        .baseline
        .clone()
        .filter(|value| value.base_ref == recorded.0 && value.base_oid == recorded.1)
        .or_else(|| original.as_ref().map(|record| record.baseline.clone()))
        .unwrap_or(RepositoryBaseline {
            base_ref: recorded.0,
            base_oid: recorded.1,
            confirmed_at: None,
            history_rewritten: None,
            remote: None,
            relationship: None,
            notice_key: None,
            warn_agent: false,
        });
    let receipt = BaselineReceipt {
        slot_id: slot_id.to_string(),
        task_key: original
            .as_ref()
            .map(|record| record.task_key.clone())
            .unwrap_or_else(|| request.session_key.clone()),
        baseline: baseline.clone(),
        warning_run_id: original.and_then(|record| record.warning_run_id),
    };
    let mut result = baseline;
    result.remote = remote.map(|remote| ConfirmedRemoteBase {
        base_ref: remote.base_ref,
        base_oid: remote.oid,
        confirmed_at: remote.confirmed_at,
    });
    result.relationship = relationship;
    if relationship == Some(BaseRelationship::Diverged) {
        result.notice_key = Some(xmatrix_cli_core::hex::sha256_hex(
            format!(
                "{}:{}:{slot_id}:{}:{}",
                layout.repo_key.as_str(),
                receipt.task_key,
                result.base_ref,
                result.base_oid
            )
            .as_bytes(),
        ));
        // Replays of the same spawn keep its prompt; later Runs get no repeat.
        result.warn_agent = receipt
            .warning_run_id
            .as_deref()
            .is_none_or(|run| run == request.run_id);
    }
    if let Some(index) = index {
        records[index] = receipt;
    } else {
        records.push(receipt);
    }
    save_baseline_receipts(layout, &records)?;
    Ok(result)
}

fn recorded_lease_base(
    layout: &RepoPoolLayout,
    request: &LeaseRequest,
    expected_slot: Option<&str>,
) -> Result<(String, String), PoolError> {
    let manifest = load_for_update(layout)?
        .ok_or_else(|| PoolError::new(PoolErrorCode::ManifestCorrupt, "pool missing"))?;
    let binding = find_exact_binding(&manifest, request)?;
    if expected_slot.is_some_and(|slot| slot != binding.slot_id) {
        return Err(PoolError::new(
            PoolErrorCode::InvalidBinding,
            "baseline slot does not match exact binding",
        ));
    }
    let slot = manifest
        .slots
        .get(&binding.slot_id)
        .ok_or_else(|| PoolError::new(PoolErrorCode::InvalidSlotId, "bound slot missing"))?;
    require_base_pair(slot)?;
    Ok((
        slot.last_base_ref.clone().unwrap(),
        slot.last_base_oid.clone().unwrap(),
    ))
}

/// Only exit 0/1 in a complete repository proves ancestry/non-ancestry.
/// Missing objects, shallow history and command errors remain Unknown.
async fn proven_ancestor(repo: &Path, base: &str, tip: &str) -> Option<bool> {
    if git(
        repo,
        &["rev-parse", "--is-shallow-repository"],
        GIT_LOCAL_TIMEOUT,
    )
    .await
    .ok()?
    .trim()
        != "false"
    {
        return None;
    }
    for oid in [base, tip] {
        git(
            repo,
            &["cat-file", "-e", &format!("{oid}^{{commit}}")],
            GIT_LOCAL_TIMEOUT,
        )
        .await
        .ok()?;
    }
    match git_output(
        repo,
        &["merge-base", "--is-ancestor", base, tip],
        GIT_LOCAL_TIMEOUT,
    )
    .await
    .ok()?
    .status
    .code()
    {
        Some(0) => Some(true),
        Some(1) => Some(false),
        _ => None,
    }
}

/// Record agent notification only after durable process admission; failed attempts
/// must leave the notification available to a later retry.
pub async fn acknowledge_baseline_warning_at(
    layout: &RepoPoolLayout,
    request: &LeaseRequest,
) -> Result<(), PoolError> {
    let _guard = acquire_pool_guard(layout).await?;
    let recorded = recorded_lease_base(layout, request, None)?;
    let manifest = load_for_update(layout)?
        .ok_or_else(|| PoolError::new(PoolErrorCode::ManifestCorrupt, "pool missing"))?;
    let binding = find_exact_binding(&manifest, request)?;
    let mut records = load_baseline_receipts(layout)?;
    if let Some(record) = records
        .iter_mut()
        .find(|record| record.slot_id == binding.slot_id && record.baseline.base_oid == recorded.1)
        && record.warning_run_id.is_none()
    {
        record.warning_run_id = Some(request.run_id.clone());
        save_baseline_receipts(layout, &records)?;
    }
    Ok(())
}
