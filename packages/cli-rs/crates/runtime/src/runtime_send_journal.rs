//! Private send intents.
//! A local record is recovery input, never proof of publication or permission.

use std::fs::{self, File};
use std::io::Read as _;
use std::path::{Path, PathBuf};

use super::runtime_private_journal::{JournalLock, lock, private};
use serde::{Deserialize, Serialize};
use serde_json::Value;

const MAX_RECORD_BYTES: u64 = 1024 * 1024;
const MAX_ENTRIES: usize = 2049; // 1 admission lock + 1024 operation/lock pairs.
/// A full journal is reclaimed down to half, so the sends after it are not each
/// one entry from the limit, rescanning every record and failing on any stray
/// temporary file.
const RECLAIM_TO_ENTRIES: usize = MAX_ENTRIES / 2;
/// The scan reads past the limit to reach reclamation; only a directory far
/// beyond anything the journal writes is refused unread.
const MAX_SCANNED_ENTRIES: usize = MAX_ENTRIES * 2;
const MAX_TOTAL_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SendScope {
    pub profile_id: Option<String>,
    pub hub_origin: String,
    pub channel_id: String,
    pub message_id: String,
    pub agent_id: String,
    pub instance_id: String,
    pub run_id: String,
    pub execution_fingerprint: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    schema_version: u32,
    scope: SendScope,
    request_fingerprint: String,
    #[serde(default)]
    agent_send_fingerprint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    final_reply_execution_id: Option<String>,
    created_at: u64,
    /// Credentials are excluded before constructing this payload.
    payload: Option<Value>,
    committed: bool,
}

pub(super) struct SendLease {
    _operation_lock: JournalLock,
    path: PathBuf,
    record: Record,
}

pub(super) use xmatrix_cli_core::hex::sha256_hex as fingerprint;

fn write_record(path: &Path, record: &Record) -> Result<(), String> {
    let bytes = serde_json::to_vec(record).map_err(|_| "Send record could not be encoded")?;
    if bytes.len() as u64 > MAX_RECORD_BYTES {
        return Err("Send record exceeds the recovery size limit".into());
    }
    super::runtime_private_journal::write_bytes(path, &bytes)
}

fn scope_key(scope: &SendScope) -> Result<String, String> {
    Ok(fingerprint(
        &serde_json::to_vec(&(&scope.hub_origin, &scope.channel_id, &scope.message_id))
            .map_err(|_| "Send identity is invalid")?,
    ))
}

/// Admission holds the directory lock. Only completed, unlocked operations
/// may be reclaimed; pending content and unrecognized artifacts stay intact.
fn reclaim_confirmed(
    root: &Path,
    count: &mut usize,
    total: &mut u64,
    incoming: u64,
) -> Result<(), String> {
    let mut candidates = Vec::new();
    for entry in fs::read_dir(root)
        .map_err(|_| "Send journal could not be read")?
        .take(MAX_SCANNED_ENTRIES)
    {
        let path = entry.map_err(|_| "Send journal could not be read")?.path();
        let metadata = fs::symlink_metadata(&path).map_err(|_| "Send journal could not be read")?;
        if path.extension().is_none_or(|ext| ext != "json")
            || metadata.len() > 8192
            || !metadata.is_file()
            || metadata.file_type().is_symlink()
        {
            continue;
        }
        let bytes = fs::read(&path).map_err(|_| "Send journal could not be read")?;
        let Ok(record) = serde_json::from_slice::<Record>(&bytes) else {
            continue;
        };
        if record.schema_version == 1
            && record.committed
            && record.payload.is_none()
            && path.file_stem().and_then(|stem| stem.to_str())
                == Some(scope_key(&record.scope)?.as_str())
        {
            candidates.push((record.created_at, path, metadata.len()));
        }
    }
    candidates.sort_by_key(|candidate| candidate.0);
    for (_, path, size) in candidates {
        if *count + 2 <= RECLAIM_TO_ENTRIES && total.saturating_add(incoming) <= MAX_TOTAL_BYTES {
            break;
        }
        let lock_path = path.with_extension("lock");
        if !lock_path.exists() {
            continue;
        }
        let Ok(guard) = lock(&lock_path) else {
            continue;
        };
        fs::remove_file(&path).map_err(|_| "Completed send record could not be reclaimed")?;
        drop(guard);
        fs::remove_file(&lock_path).map_err(|_| "Completed send lock could not be reclaimed")?;
        *count = count.saturating_sub(2);
        *total = total.saturating_sub(size);
    }
    Ok(())
}

fn read_record(
    path: &Path,
    scope: &SendScope,
    expected_fingerprint: Option<&str>,
) -> Result<Record, String> {
    private(path, false)?;
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(|_| "Send record could not be read")?
        .take(MAX_RECORD_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Send record could not be read")?;
    if bytes.len() as u64 > MAX_RECORD_BYTES {
        return Err("Send record is oversized and was retained".into());
    }
    let record: Record =
        serde_json::from_slice(&bytes).map_err(|_| "Send record is invalid and was retained")?;
    if record.schema_version != 1
        || record.scope != *scope
        || expected_fingerprint.is_some_and(|expected| record.request_fingerprint != expected)
    {
        return Err(
            "Message ID belongs to a different send operation; existing record was retained".into(),
        );
    }
    if record
        .final_reply_execution_id
        .as_deref()
        .is_some_and(|id| {
            record.payload.as_ref().is_some_and(|payload| {
                payload.get("finalReplyExecutionId").and_then(Value::as_str) != Some(id)
            })
        })
        || record.committed != record.payload.is_none()
        || record.payload.as_ref().is_some_and(|stored| {
            serde_json::to_vec(stored)
                .map(|bytes| fingerprint(&bytes) != record.request_fingerprint)
                .unwrap_or(true)
                || record
                    .agent_send_fingerprint
                    .as_ref()
                    .is_some_and(|expected| {
                        super::runtime_send_submission::submission_fingerprint(
                            &record.scope,
                            stored,
                        )
                        .as_ref()
                            != Some(expected)
                    })
        })
    {
        return Err("Send record content is inconsistent and was retained".into());
    }
    Ok(record)
}

impl SendLease {
    pub(super) fn open(root: &Path, scope: &SendScope) -> Result<Self, String> {
        private(root, true)?;
        let _admission = lock(&root.join("admission.lock"))?;
        let key = scope_key(scope)?;
        let path = root.join(format!("{key}.json"));
        if !path.exists() {
            return Err("No saved send operation; use the message receipt diagnostic".into());
        }
        let operation_lock = lock(&root.join(format!("{key}.lock")))?;
        let record = read_record(&path, scope, None)?;
        Ok(Self {
            _operation_lock: operation_lock,
            path,
            record,
        })
    }

    pub(super) fn submission_fingerprint(&self) -> Option<String> {
        self.record.agent_send_fingerprint.clone().or_else(|| {
            self.record.payload.as_ref().and_then(|payload| {
                super::runtime_send_submission::submission_fingerprint(&self.record.scope, payload)
            })
        })
    }

    pub(super) fn retry_payload(&self, now: u64) -> Result<Value, String> {
        // Keep automatic replay well inside the Hub's 30-day receipt retention.
        // Local age only restricts retry; it never grants permission to append.
        if self.record.committed
            || now < self.record.created_at
            || now - self.record.created_at > 86400
        {
            return Err(
                "Saved send is outside the retry window; inspect its authoritative receipt".into(),
            );
        }
        self.record
            .payload
            .clone()
            .ok_or_else(|| "Saved send has no pending content".into())
    }

    /// Locks are fail-fast and released on cancellation, process exit or Drop.
    /// Unknown and corrupt records are retained, never silently overwritten.
    pub(super) fn prepare(
        root: &Path,
        scope: SendScope,
        payload: Value,
        now: u64,
    ) -> Result<Self, String> {
        fs::create_dir_all(root).map_err(|_| "Send journal directory is unavailable")?;
        private(root, true)?;
        let _admission = lock(&root.join("admission.lock"))?;
        let key = scope_key(&scope)?;
        let path = root.join(format!("{key}.json"));
        let lock_path = root.join(format!("{key}.lock"));
        let bytes = serde_json::to_vec(&payload).map_err(|_| "Send payload is invalid")?;
        if bytes.len() as u64 > MAX_RECORD_BYTES - 4096 {
            return Err("Send record exceeds the recovery size limit".into());
        }
        // Bounded scan includes interrupted temporary files and lock files.
        let mut count = 0;
        let mut total = 0_u64;
        for entry in fs::read_dir(root).map_err(|_| "Send journal could not be read")? {
            count += 1;
            if count > MAX_SCANNED_ENTRIES {
                return Err("Send journal capacity reached; existing records were retained".into());
            }
            let entry = entry.map_err(|_| "Send journal could not be read")?;
            let metadata =
                fs::symlink_metadata(entry.path()).map_err(|_| "Send journal could not be read")?;
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return Err("Send journal contains an unexpected artifact".into());
            }
            total = total.saturating_add(metadata.len());
        }
        let existing = path.exists();
        let incoming_bytes = bytes.len() as u64 + 4096;
        if !existing
            && (count + 2 > MAX_ENTRIES || total.saturating_add(incoming_bytes) > MAX_TOTAL_BYTES)
        {
            reclaim_confirmed(root, &mut count, &mut total, incoming_bytes)?;
        }
        if !existing
            && (count + 1 + usize::from(!lock_path.exists()) > MAX_ENTRIES
                || total.saturating_add(bytes.len() as u64 + 4096) > MAX_TOTAL_BYTES)
        {
            return Err("Send journal capacity reached; existing records were retained".into());
        }
        let operation_lock = lock(&lock_path)?;
        let request_fingerprint = fingerprint(&bytes);
        let record = if existing {
            read_record(&path, &scope, Some(&request_fingerprint))?
        } else {
            let record = Record {
                schema_version: 1,
                agent_send_fingerprint: super::runtime_send_submission::submission_fingerprint(
                    &scope, &payload,
                ),
                final_reply_execution_id: payload
                    .get("finalReplyExecutionId")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                scope,
                request_fingerprint,
                created_at: now,
                payload: Some(payload),
                committed: false,
            };
            write_record(&path, &record)?;
            record
        };
        Ok(Self {
            _operation_lock: operation_lock,
            path,
            record,
        })
    }

    pub(super) fn confirm(mut self) -> Result<(), String> {
        if self.record.final_reply_execution_id.is_none() {
            self.record.final_reply_execution_id = self
                .record
                .payload
                .as_ref()
                .and_then(|payload| payload.get("finalReplyExecutionId").and_then(Value::as_str))
                .map(str::to_string);
        }
        self.record.committed = true;
        // Publication is confirmed; retain the fingerprint without the content.
        self.record.payload = None;
        write_record(&self.path, &self.record)
    }

    /// The Hub refused this send and its receipt shows no commit, so there is
    /// nothing left to recover. Only an uncommitted record is ever removed.
    pub(super) fn discard(self) -> Result<(), String> {
        if self.record.committed {
            return Err("A committed send record is never discarded".into());
        }
        fs::remove_file(&self.path).map_err(|_| "Rejected send record could not be removed")?;
        let lock_path = self.path.with_extension("lock");
        drop(self);
        let _ = fs::remove_file(lock_path);
        Ok(())
    }
}

/// Inventory contains only exact Run-bound operation references, never content.
pub(super) fn execution_sends(
    root: &Path,
    scope: &SendScope,
    execution_id: &str,
) -> Result<Vec<(String, u64)>, String> {
    if !root.exists() {
        return Ok(Vec::new());
    }
    private(root, true)?;
    let _admission = lock(&root.join("admission.lock"))?;
    let mut selected = Vec::new();
    let mut count = 0;
    let mut total_bytes = 0u64;
    for entry in fs::read_dir(root)
        .map_err(|_| "Send records are unavailable")?
        .take(MAX_ENTRIES + 1)
    {
        count += 1;
        if count > MAX_ENTRIES {
            return Err("Send records exceed the inspection bound".into());
        }
        let path = entry.map_err(|_| "Send records are unavailable")?.path();
        if path.extension().is_none_or(|ext| ext != "json") {
            continue;
        }
        private(&path, false)?;
        let mut bytes = Vec::new();
        File::open(&path)
            .map_err(|_| "Send record is unavailable")?
            .take(MAX_RECORD_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "Send record is unavailable")?;
        total_bytes = total_bytes.saturating_add(bytes.len() as u64);
        if total_bytes > MAX_TOTAL_BYTES {
            return Err("Send records exceed the inspection byte bound".into());
        }
        if bytes.len() as u64 > MAX_RECORD_BYTES {
            continue;
        }
        let Ok(record) = serde_json::from_slice::<Record>(&bytes) else {
            continue;
        };
        let mut expected = scope.clone();
        expected.message_id = record.scope.message_id.clone();
        if record.scope != expected || path != root.join(format!("{}.json", scope_key(&expected)?))
        {
            continue;
        }
        let record = read_record(&path, &expected, None)?;
        let final_id = record.final_reply_execution_id.as_deref().or_else(|| {
            record
                .payload
                .as_ref()
                .and_then(|payload| payload.get("finalReplyExecutionId"))
                .and_then(Value::as_str)
        });
        if final_id == Some(execution_id) {
            selected.push((expected.message_id, record.created_at));
            if selected.len() > 20 {
                return Err("Too many saved replies for this execution".into());
            }
        }
    }
    selected.sort_by(|a, b| a.1.cmp(&b.1).then(a.0.cmp(&b.0)));
    Ok(selected)
}

#[cfg(test)]
#[path = "tests/tests_send_journal.rs"]
mod tests;
