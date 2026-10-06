//! Pending execution evidence. Local persistence is not a Hub acknowledgement.
use super::runtime_private_journal::{lock_with_deadline, private, stage_bytes};
use super::runtime_send_journal::fingerprint;
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Read as _;
use std::path::{Path, PathBuf};
use xmatrix_cli_core::{config, protocol::AgentRuntimeExecutionEvidence};

// 1024 report/lock pairs, plus room for an `admission.lock` left behind by a
// release that still guarded this directory with one machine-wide lock.
const MAX_ENTRIES: usize = 2049;
const MAX_BYTES: u64 = 32 * 1024 * 1024;
const MAX_RECORD_BYTES: u64 = 128 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ExecutionScope {
    pub hub_origin: String,
    pub channel_id: String,
    pub agent_id: String,
    pub run_id: String,
    pub instance_id: String,
    pub execution_fingerprint: String,
}

#[derive(Clone, Debug)]
pub(super) struct ExecutionOutbox {
    root: PathBuf,
    scope: ExecutionScope,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PendingExecution {
    schema_version: u32,
    scope: ExecutionScope,
    report: AgentRuntimeExecutionEvidence,
}

impl ExecutionOutbox {
    pub(super) fn from_environment() -> Option<Self> {
        let value = |key| {
            std::env::var(key).ok().filter(|value| {
                !value.is_empty() && value.len() <= 300 && !value.chars().any(char::is_control)
            })
        };
        let hub = reqwest::Url::parse(&value("XMATRIX_HUB_URL")?).ok()?;
        if !matches!(hub.scheme(), "https" | "http") || hub.host_str().is_none() {
            return None;
        }
        Some(Self {
            root: config::profile_state_dir().join("execution-outbox"),
            scope: ExecutionScope {
                hub_origin: hub.origin().ascii_serialization(),
                channel_id: value("XMATRIX_AUTO_JOIN_CHANNEL_ID")?,
                agent_id: value("XMATRIX_AGENT_ID")?,
                run_id: value("XMATRIX_RUN_ID")?,
                instance_id: value("XMATRIX_AGENT_INSTANCE_ID")?,
                execution_fingerprint: fingerprint(value("XMATRIX_EXECUTION_KEY")?.as_bytes()),
            },
        })
    }

    /// Digest of the exact execution identity: the Hub origin, Channel, Agent,
    /// Run, Instance and execution id. Two Runs therefore can never address one
    /// record, which is what makes a per-record lock sufficient.
    fn record_key(&self, id: &str) -> Result<String, String> {
        let key =
            serde_json::to_vec(&(&self.scope, id)).map_err(|_| "Execution identity is invalid")?;
        Ok(fingerprint(&key))
    }

    fn path(&self, id: &str) -> Result<PathBuf, String> {
        Ok(self.root.join(format!("{}.json", self.record_key(id)?)))
    }

    /// A lock file of its own, never replaced, so a lock is not dropped by the
    /// atomic rename that publishes the record it guards.
    pub(super) fn record_lock(&self, id: &str) -> Result<PathBuf, String> {
        Ok(self.root.join(format!("{}.lock", self.record_key(id)?)))
    }

    #[cfg(test)]
    pub(super) fn for_test(root: PathBuf) -> Self {
        Self {
            root,
            scope: ExecutionScope {
                hub_origin: "https://hub.test".into(),
                channel_id: "channel".into(),
                agent_id: "agent".into(),
                run_id: "run".into(),
                instance_id: "instance".into(),
                execution_fingerprint: "a".repeat(64),
            },
        }
    }

    /// Replace one execution monotonically, preserving all other pending results.
    /// Admission never evicts unacknowledged reports to make room.
    pub(super) fn save(&self, report: &AgentRuntimeExecutionEvidence) -> Result<(), String> {
        validate_report(report, &self.scope.channel_id)?;
        fs::create_dir_all(&self.root).map_err(|_| "Execution outbox directory is unavailable")?;
        private(&self.root, true)?;
        let path = self.path(&report.execution_id)?;
        let record = PendingExecution {
            schema_version: 1,
            scope: self.scope.clone(),
            report: report.clone(),
        };
        let bytes =
            serde_json::to_vec(&record).map_err(|_| "Execution report could not be encoded")?;
        if bytes.len() as u64 > MAX_RECORD_BYTES {
            return Err("Execution report exceeds the storage bound".into());
        }
        // The bound is a guard rail against unbounded growth, not an invariant
        // any reader depends on, so it is measured outside the lock. Draining is
        // what brings an over-full outbox back down and must never be blocked by
        // the fullness it is there to relieve.
        let capacity = self.capacity(&path)?;
        if capacity.would_exceed(bytes.len() as u64, !path.exists()) {
            return Err("Execution outbox is full; pending reports were retained".into());
        }
        // Staged before the lock: a record's bytes are decided by this report
        // alone, never by what is already stored, so the fsync that persists
        // them does not belong inside the guarded window.
        let staged = stage_bytes(&path, &bytes)?;
        // Per record rather than per machine. `path` digests the Run and
        // Instance, so two Runs cannot address one record; a machine-wide lock
        // made every Run on the host queue behind writes that never collided.
        let _guard = lock_with_deadline(&self.record_lock(&report.execution_id)?)?;
        let prior = match fs::symlink_metadata(&path) {
            Ok(_) => Some(read(&path)?),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => return Err("Execution outbox record is unavailable".into()),
        };
        if let Some(prior) = &prior {
            if prior.scope != self.scope || !same_binding(&prior.report, report) {
                return Err("Execution identity changed; the original report was retained".into());
            }
            if prior.report.revision > report.revision {
                return Ok(());
            }
            if prior.report.revision == report.revision {
                return if prior.report == *report {
                    Ok(())
                } else {
                    Err("Conflicting execution revision was retained".into())
                };
            }
            if prior.report.finished_at_millis.is_some() {
                return Err("A terminal execution cannot be reopened".into());
            }
        }
        staged.install()
    }

    /// Measure the outbox against its storage bounds, discounting the record
    /// this write would replace.
    fn capacity(&self, path: &Path) -> Result<Capacity, String> {
        let entries = fs::read_dir(&self.root).map_err(|_| "Execution outbox is unavailable")?;
        measure_capacity(entries, path)
    }
}

// Directory entries are a moving snapshot: another writer may atomically
// install a staged file, or a drainer may remove an acknowledged record,
// between read_dir and stat. Only NotFound is benign; other I/O failures and
// unsupported artifacts still fail closed. The scan remains bounded even when
// every observed entry disappears.
fn measure_capacity(
    entries: impl Iterator<Item = std::io::Result<fs::DirEntry>>,
    path: &Path,
) -> Result<Capacity, String> {
    let mut count = 0;
    let mut total = 0u64;
    for entry in entries.take(MAX_ENTRIES + 1) {
        count += 1;
        let entry = entry.map_err(|_| "Execution outbox is unavailable")?;
        let metadata = match fs::symlink_metadata(entry.path()) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err("Execution outbox is unavailable".into()),
        };
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(
                "Execution outbox contains an unsupported artifact; it was retained".into(),
            );
        }
        total = total.saturating_add(metadata.len());
    }
    let replaced = fs::metadata(path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    Ok(Capacity {
        count,
        total,
        replaced,
    })
}

struct Capacity {
    count: usize,
    total: u64,
    replaced: u64,
}

impl Capacity {
    fn would_exceed(&self, bytes: u64, fresh: bool) -> bool {
        // A fresh record costs its own file and its lock file.
        self.count + if fresh { 2 } else { 0 } > MAX_ENTRIES
            || self
                .total
                .saturating_sub(self.replaced)
                .saturating_add(bytes)
                > MAX_BYTES
    }
}

fn same_binding(a: &AgentRuntimeExecutionEvidence, b: &AgentRuntimeExecutionEvidence) -> bool {
    a.execution_id == b.execution_id
        && a.sources == b.sources
        && a.source_count == b.source_count
        && a.started_at_millis == b.started_at_millis
}

fn validate_report(report: &AgentRuntimeExecutionEvidence, channel: &str) -> Result<(), String> {
    let terminal = !matches!(report.state.as_str(), "accepted" | "running");
    if uuid::Uuid::parse_str(&report.execution_id)
        .ok()
        .is_none_or(|id| id.to_string() != report.execution_id)
        || report.revision == 0
        || report.sources.is_empty()
        || report.sources.len() > 100
        || report.source_count < report.sources.len() as u32
        || report.source_count > 100
        || !matches!(
            report.state.as_str(),
            "accepted" | "running" | "completed" | "failed" | "interrupted" | "unknown"
        )
        || report.updated_at_millis < report.started_at_millis
        || terminal != report.finished_at_millis.is_some()
        || report.updated_at_millis > 8_640_000_000_000_000
        || report
            .finished_at_millis
            .is_some_and(|at| at < report.started_at_millis || at > report.updated_at_millis)
        || report
            .input_disposition
            .as_deref()
            .is_some_and(|state| !matches!(state, "pending" | "submitted" | "resumed_existing"))
        || report.input_disposition.as_deref() == Some("resumed_existing")
            && !matches!(report.state.as_str(), "accepted" | "unknown")
    {
        return Err("Execution report is invalid".into());
    }
    let mut sources = std::collections::HashSet::new();
    for source in &report.sources {
        if source.channel_id != channel
            || source.message_id.is_empty()
            || source.message_id.len() > 300
            || source.message_id.chars().any(char::is_control)
            || source.sequence == 0
            || source.entity_version == 0
            || source.sequence > 9_007_199_254_740_991
            || source.entity_version > 9_007_199_254_740_991
            || source.body_hash.len() != 64
            || !source
                .body_hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || !sources.insert(&source.message_id)
        {
            return Err("Execution source is invalid".into());
        }
    }
    Ok(())
}

fn read(path: &Path) -> Result<PendingExecution, String> {
    private(path, false)?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let mut bytes = Vec::new();
    options
        .open(path)
        .map_err(|_| "Execution record cannot be opened")?
        .take(MAX_RECORD_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Execution record cannot be read")?;
    if bytes.len() as u64 > MAX_RECORD_BYTES {
        return Err("Oversized execution record was retained".into());
    }
    let record: PendingExecution =
        serde_json::from_slice(&bytes).map_err(|_| "Malformed execution record was retained")?;
    if record.schema_version != 1 {
        return Err("Unknown execution record version was retained".into());
    }
    validate_report(&record.report, &record.scope.channel_id)?;
    Ok(record)
}

#[cfg(test)]
#[path = "runtime_execution_outbox_tests.rs"]
mod tests;

#[path = "runtime_execution_outbox_delivery.rs"]
mod delivery;
pub(super) use delivery::spawn_reporter;
