#![deny(warnings)]

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[cfg(windows)]
mod ipc;
#[cfg(windows)]
pub use ipc::{CONTROL_PROTOCOL_ENV, CONTROL_READ_HANDLE_ENV, CONTROL_WRITE_HANDLE_ENV};
#[cfg(windows)]
pub use ipc::{ChildControlHandles, InheritedControlPipe, connect_inherited_control_pipe};

pub const JOURNAL_SCHEMA: u32 = 1;
pub const SUPERVISOR_PROTOCOL_MAJOR: u16 = 1;
pub const MAX_CONTROL_FRAME_BYTES: usize = 64 * 1024;
pub const MAX_EFFECT_JOURNAL_BYTES: usize = 1024 * 1024;
pub const MAX_RELEASE_ENVELOPE_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_QUARANTINED_ARTIFACTS: usize = 256;
pub const MAX_CONTINUITY_EVENTS: usize = 512;
const RELEASE_ENVELOPE_MAGIC: &[u8] = b"\nXMATRIX_RELEASE_ENVELOPE_V1\0";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseEnvelopePayload {
    pub workflow: String,
    pub run_id: u64,
    pub run_attempt: u32,
    pub git_sha: String,
    pub provenance: String,
    pub release_sequence: u64,
    pub target: String,
    pub size: u64,
    pub sha256: String,
    pub publisher: String,
    pub protocol_min: u16,
    pub protocol_max: u16,
    pub rollback_floor: u64,
    pub expires_at_unix: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedReleaseEnvelope {
    pub schema: u32,
    pub payload: ReleaseEnvelopePayload,
}

pub fn release_sequence_from_version(version: &str) -> Result<u64, ContinuityError> {
    let stable = version.split_once('-').map_or(version, |(value, _)| value);
    let mut parts = stable.split('.');
    let major = parts.next().and_then(|value| value.parse::<u64>().ok());
    let minor = parts.next().and_then(|value| value.parse::<u64>().ok());
    let patch = parts.next().and_then(|value| value.parse::<u64>().ok());
    if parts.next().is_some()
        || major.is_none()
        || minor.is_none()
        || patch.is_none()
        || minor.is_some_and(|value| value >= 1_000_000)
        || patch.is_some_and(|value| value >= 1_000_000)
    {
        return Err(ContinuityError::Invalid(
            "release version has no monotonic continuity sequence",
        ));
    }
    major
        .expect("validated major")
        .checked_mul(1_000_000_000_000)
        .and_then(|value| value.checked_add(minor.expect("validated minor") * 1_000_000))
        .and_then(|value| value.checked_add(patch.expect("validated patch")))
        .filter(|value| *value > 0)
        .ok_or(ContinuityError::Invalid(
            "release version has no monotonic continuity sequence",
        ))
}

pub fn read_embedded_release_envelope(
    path: &Path,
) -> Result<EmbeddedReleaseEnvelope, ContinuityError> {
    let bytes = read_bounded(path, MAX_RELEASE_ENVELOPE_BYTES)?;
    let matches = bytes
        .windows(RELEASE_ENVELOPE_MAGIC.len())
        .enumerate()
        .filter_map(|(index, value)| (value == RELEASE_ENVELOPE_MAGIC).then_some(index))
        .collect::<Vec<_>>();
    if matches.len() != 1 || matches[0] < 8 {
        return Err(ContinuityError::Invalid(
            "release envelope trailer is missing or ambiguous",
        ));
    }
    let marker = matches[0];
    let size = u64::from_le_bytes(
        bytes[marker - 8..marker]
            .try_into()
            .map_err(|_| ContinuityError::Invalid("release envelope length is invalid"))?,
    ) as usize;
    if size == 0 || size > MAX_CONTROL_FRAME_BYTES || marker < 8 + size {
        return Err(ContinuityError::Invalid(
            "release envelope payload is oversized or truncated",
        ));
    }
    let envelope: EmbeddedReleaseEnvelope =
        serde_json::from_slice(&bytes[marker - 8 - size..marker - 8])?;
    if envelope.schema != 1 {
        return Err(ContinuityError::Invalid(
            "release envelope schema is unsupported",
        ));
    }
    Ok(envelope)
}

pub fn encode_release_envelope_trailer(
    envelope: &EmbeddedReleaseEnvelope,
) -> Result<Vec<u8>, ContinuityError> {
    if envelope.schema != 1 {
        return Err(ContinuityError::Invalid(
            "release envelope schema is unsupported",
        ));
    }
    let payload = serde_json::to_vec(envelope)?;
    if payload.is_empty() || payload.len() > MAX_CONTROL_FRAME_BYTES {
        return Err(ContinuityError::FrameTooLarge(payload.len()));
    }
    let mut trailer = Vec::with_capacity(payload.len() + 8 + RELEASE_ENVELOPE_MAGIC.len());
    trailer.extend_from_slice(&payload);
    trailer.extend_from_slice(&(payload.len() as u64).to_le_bytes());
    trailer.extend_from_slice(RELEASE_ENVELOPE_MAGIC);
    Ok(trailer)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthenticatedControlFrame {
    pub protocol_major: u16,
    pub sequence: u64,
    pub nonce: String,
    pub message: ControlMessage,
}

pub struct ReplayGuard {
    nonce: String,
    next_sequence: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContinuityEvent {
    pub sequence: u64,
    pub unix_time: u64,
    pub component: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transaction_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail_code: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ContinuityEventEnvelope {
    schema: u32,
    revision: u64,
    events: Vec<ContinuityEvent>,
    checksum_sha256: String,
}

pub struct ContinuityEventLog {
    path: PathBuf,
}

impl ContinuityEventLog {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn append(
        &self,
        component: &str,
        kind: &str,
        transaction_id: Option<&str>,
        artifact_sha256: Option<&str>,
        phase: Option<&str>,
        detail_code: Option<&str>,
    ) -> Result<ContinuityEvent, ContinuityError> {
        use fs2::FileExt as _;

        let parent = self
            .path
            .parent()
            .ok_or(ContinuityError::Invalid("event log has no parent"))?;
        fs::create_dir_all(parent)?;
        let lock_path = parent.join(format!(
            ".{}.lock",
            self.path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("continuity-events")
        ));
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(lock_path)?;
        lock.lock_exclusive()?;
        for value in [component, kind]
            .into_iter()
            .chain(phase)
            .chain(detail_code)
        {
            if value.is_empty()
                || value.len() > 96
                || !value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
            {
                return Err(ContinuityError::Invalid(
                    "continuity event label is invalid",
                ));
            }
        }
        if transaction_id.is_some_and(|value| {
            value.is_empty()
                || value.len() > 180
                || !value.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'.' | b'_' | b'-')
                })
        }) || artifact_sha256.is_some_and(|value| {
            value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit())
        }) {
            return Err(ContinuityError::Invalid(
                "continuity event identity is invalid",
            ));
        }
        let (revision, mut events) = match self.read_envelope() {
            Ok(value) => (value.revision.saturating_add(1), value.events),
            Err(ContinuityError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
                (1, Vec::new())
            }
            Err(error) => return Err(error),
        };
        let event = ContinuityEvent {
            sequence: revision,
            unix_time: current_unix_time()?,
            component: component.to_string(),
            kind: kind.to_string(),
            transaction_id: transaction_id.map(str::to_string),
            artifact_sha256: artifact_sha256.map(str::to_string),
            phase: phase.map(str::to_string),
            detail_code: detail_code.map(str::to_string),
        };
        events.push(event.clone());
        if events.len() > MAX_CONTINUITY_EVENTS {
            events.drain(..events.len() - MAX_CONTINUITY_EVENTS);
        }
        let checksum_sha256 = event_checksum(1, revision, &events)?;
        atomic_replace(
            &self.path,
            &serde_json::to_vec_pretty(&ContinuityEventEnvelope {
                schema: 1,
                revision,
                events,
                checksum_sha256,
            })?,
        )?;
        Ok(event)
    }

    pub fn read(&self) -> Result<Vec<ContinuityEvent>, ContinuityError> {
        Ok(self.read_envelope()?.events)
    }

    fn read_envelope(&self) -> Result<ContinuityEventEnvelope, ContinuityError> {
        let bytes = read_bounded(&self.path, MAX_EFFECT_JOURNAL_BYTES)?;
        let envelope: ContinuityEventEnvelope = serde_json::from_slice(&bytes)?;
        if envelope.schema != 1
            || envelope.revision == 0
            || envelope.events.len() > MAX_CONTINUITY_EVENTS
            || envelope.checksum_sha256
                != event_checksum(envelope.schema, envelope.revision, &envelope.events)?
        {
            return Err(ContinuityError::ChecksumMismatch);
        }
        Ok(envelope)
    }
}

fn event_checksum(
    schema: u32,
    revision: u64,
    events: &[ContinuityEvent],
) -> Result<String, ContinuityError> {
    Ok(hex_sha256(&serde_json::to_vec(&(
        schema, revision, events,
    ))?))
}

impl ReplayGuard {
    pub fn new(nonce: String) -> Result<Self, ContinuityError> {
        if nonce.len() < 32 {
            return Err(ContinuityError::Invalid("control nonce is too short"));
        }
        Ok(Self {
            nonce,
            next_sequence: 1,
        })
    }

    pub fn validate(&mut self, frame: &AuthenticatedControlFrame) -> Result<(), ContinuityError> {
        if frame.protocol_major != SUPERVISOR_PROTOCOL_MAJOR
            || frame.nonce != self.nonce
            || frame.sequence != self.next_sequence
        {
            return Err(ContinuityError::ReplayRejected);
        }
        self.next_sequence = self.next_sequence.saturating_add(1);
        Ok(())
    }
}

pub fn encode_authenticated_frame(
    frame: &AuthenticatedControlFrame,
) -> Result<Vec<u8>, ContinuityError> {
    let payload = serde_json::to_vec(frame)?;
    if payload.len() > MAX_CONTROL_FRAME_BYTES {
        return Err(ContinuityError::FrameTooLarge(payload.len()));
    }
    let mut bytes = Vec::with_capacity(payload.len() + 4);
    bytes.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    bytes.extend_from_slice(&payload);
    Ok(bytes)
}

pub fn decode_authenticated_frame(
    reader: &mut impl Read,
) -> Result<AuthenticatedControlFrame, ContinuityError> {
    let mut header = [0u8; 4];
    reader.read_exact(&mut header)?;
    let size = u32::from_be_bytes(header) as usize;
    if size > MAX_CONTROL_FRAME_BYTES {
        return Err(ContinuityError::FrameTooLarge(size));
    }
    let mut payload = vec![0; size];
    reader.read_exact(&mut payload)?;
    Ok(serde_json::from_slice(&payload)?)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BootPhase {
    Stable,
    Pending,
    Quarantined,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BootPayload {
    pub schema: u32,
    pub revision: u64,
    pub phase: BootPhase,
    pub committed: ArtifactIdentity,
    pub previous: Option<ArtifactIdentity>,
    pub pending: Option<ArtifactIdentity>,
    pub quarantined_sha256: BTreeSet<String>,
}

impl BootPayload {
    pub fn selected(&self) -> Result<&ArtifactIdentity, ContinuityError> {
        if self.schema != JOURNAL_SCHEMA || self.revision == 0 {
            return Err(ContinuityError::Invalid(
                "boot journal schema or revision is invalid",
            ));
        }
        self.committed.validate()?;
        match self.phase {
            BootPhase::Stable => Ok(&self.committed),
            BootPhase::Pending => {
                let pending = self
                    .pending
                    .as_ref()
                    .ok_or(ContinuityError::Invalid("pending boot has no candidate"))?;
                pending.validate()?;
                if self.quarantined_sha256.contains(&pending.sha256) {
                    return Err(ContinuityError::Invalid(
                        "pending Supervisor is quarantined",
                    ));
                }
                Ok(pending)
            }
            BootPhase::Quarantined => Err(ContinuityError::Invalid("boot state is quarantined")),
        }
    }
}

pub struct BootJournal {
    path: PathBuf,
}

impl BootJournal {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn load(&self) -> Result<BootPayload, ContinuityError> {
        load_with_previous_image(&self.path, |path| self.load_path(path))
    }

    fn load_path(&self, path: &Path) -> Result<BootPayload, ContinuityError> {
        let bytes = read_bounded(path, MAX_CONTROL_FRAME_BYTES)?;
        let envelope: BootEnvelope = serde_json::from_slice(&bytes)?;
        verify_payload_checksum(&envelope.payload, &envelope.checksum_sha256)?;
        envelope.payload.selected()?;
        Ok(envelope.payload)
    }

    pub fn store(&self, payload: &BootPayload) -> Result<(), ContinuityError> {
        payload.selected()?;
        let envelope = BootEnvelope {
            checksum_sha256: payload_checksum(payload)?,
            payload: payload.clone(),
        };
        store_with_previous_image(&self.path, &envelope, || self.load_path(&self.path).is_ok())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BootEnvelope {
    payload: BootPayload,
    checksum_sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactIdentity {
    pub generation: String,
    pub sha256: String,
    pub executable_path: PathBuf,
    pub release_envelope_path: PathBuf,
    pub release_envelope_sha256: String,
    pub publisher_sha256: String,
    pub version: String,
    pub target: String,
    pub release_sequence: u64,
    pub protocol_min: u16,
    pub protocol_max: u16,
}

impl ArtifactIdentity {
    pub fn validate(&self) -> Result<(), ContinuityError> {
        if !is_safe_generation_name(&self.generation) {
            return Err(ContinuityError::Invalid(
                "generation is not a safe component",
            ));
        }
        if self.sha256.len() != 64 || !self.sha256.bytes().all(|value| value.is_ascii_hexdigit()) {
            return Err(ContinuityError::Invalid(
                "artifact digest is not full SHA-256",
            ));
        }
        if self.release_envelope_sha256.len() != 64
            || !self
                .release_envelope_sha256
                .bytes()
                .all(|value| value.is_ascii_hexdigit())
            || self.publisher_sha256.len() != 64
            || !self
                .publisher_sha256
                .bytes()
                .all(|value| value.is_ascii_hexdigit())
        {
            return Err(ContinuityError::Invalid(
                "artifact envelope or publisher identity is invalid",
            ));
        }
        if self.version.trim().is_empty() || self.target.trim().is_empty() {
            return Err(ContinuityError::Invalid(
                "artifact version or target is empty",
            ));
        }
        if self.protocol_min > SUPERVISOR_PROTOCOL_MAJOR
            || self.protocol_max < SUPERVISOR_PROTOCOL_MAJOR
        {
            return Err(ContinuityError::Invalid(
                "artifact protocol range is incompatible",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransactionKind {
    Update,
    Rollback,
    CrashRecovery,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActivationPhase {
    Stable,
    CandidateStaged,
    PreflightPassed,
    Draining,
    OldExited,
    Recovering,
    ActivationPrepared,
    LocalCommitted,
    ActiveFenced,
    Probation,
    HubActive,
    StablePersisted,
    StableGranted,
    RolledBack,
    Degraded,
}

impl ActivationPhase {
    pub fn permits(self, next: Self) -> bool {
        use ActivationPhase as P;
        matches!(
            (self, next),
            (P::Stable, P::CandidateStaged)
                | (P::Stable, P::Recovering)
                | (P::CandidateStaged, P::PreflightPassed)
                | (P::PreflightPassed, P::Draining)
                | (P::Draining, P::OldExited)
                | (P::OldExited, P::Recovering)
                | (P::Recovering, P::ActivationPrepared)
                | (P::ActivationPrepared, P::LocalCommitted)
                | (P::LocalCommitted, P::ActiveFenced)
                | (P::ActiveFenced, P::Probation)
                | (P::Probation, P::HubActive)
                | (P::HubActive, P::StablePersisted)
                | (P::StablePersisted, P::StableGranted)
                | (P::StableGranted, P::Stable)
                | (P::CandidateStaged, P::RolledBack)
                | (P::PreflightPassed, P::RolledBack)
                | (P::Draining, P::RolledBack)
                | (P::Recovering, P::Degraded)
                | (P::ActivationPrepared, P::Degraded)
                | (P::LocalCommitted, P::Recovering)
                | (P::ActiveFenced, P::Recovering)
                | (P::Probation, P::Recovering)
                | (P::HubActive, P::Recovering)
                | (P::RolledBack, P::Stable)
                | (P::Degraded, P::Recovering)
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivationTransaction {
    pub id: String,
    pub nonce: String,
    pub kind: TransactionKind,
    pub phase: ActivationPhase,
    pub source_sha256: String,
    pub target_sha256: String,
    pub run_set_digest: Option<String>,
    pub hub_receipt_ids: BTreeMap<String, String>,
    pub attempt: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_hub_epoch: Option<u64>,
}

impl ActivationTransaction {
    pub fn advance(&mut self, next: ActivationPhase) -> Result<(), ContinuityError> {
        if !self.phase.permits(next) {
            return Err(ContinuityError::InvalidTransition(self.phase, next));
        }
        self.phase = next;
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalPayload {
    pub schema: u32,
    pub revision: u64,
    pub committed: ArtifactIdentity,
    pub previous: Option<ArtifactIdentity>,
    pub candidate: Option<ArtifactIdentity>,
    pub transaction: Option<ActivationTransaction>,
    pub quarantined_sha256: BTreeSet<String>,
    pub generation_pins: BTreeSet<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_hub_epoch: Option<u64>,
}

impl JournalPayload {
    pub fn validate(&self) -> Result<(), ContinuityError> {
        if self.schema != JOURNAL_SCHEMA || self.revision == 0 {
            return Err(ContinuityError::Invalid(
                "journal schema or revision is invalid",
            ));
        }
        self.committed.validate()?;
        if let Some(previous) = &self.previous {
            previous.validate()?;
        }
        if let Some(candidate) = &self.candidate {
            candidate.validate()?;
            if self.quarantined_sha256.contains(&candidate.sha256) {
                return Err(ContinuityError::Invalid("candidate is quarantined"));
            }
        }
        if let Some(transaction) = &self.transaction {
            if transaction.id.trim().is_empty() || transaction.nonce.len() < 32 {
                return Err(ContinuityError::Invalid("transaction identity is invalid"));
            }
            if transaction.source_hub_epoch == Some(0) {
                return Err(ContinuityError::Invalid(
                    "transaction source Hub epoch is invalid",
                ));
            }
            let committed_digest = if matches!(
                transaction.phase,
                ActivationPhase::LocalCommitted
                    | ActivationPhase::ActiveFenced
                    | ActivationPhase::Probation
                    | ActivationPhase::HubActive
                    | ActivationPhase::StablePersisted
                    | ActivationPhase::StableGranted
            ) {
                &transaction.target_sha256
            } else {
                &transaction.source_sha256
            };
            if committed_digest != &self.committed.sha256 {
                return Err(ContinuityError::Invalid(
                    "transaction phase does not match committed artifact",
                ));
            }
        }
        Ok(())
    }

    pub fn pinned_generations(&self) -> BTreeSet<String> {
        let mut pins = self.generation_pins.clone();
        pins.insert(self.committed.generation.clone());
        if let Some(previous) = &self.previous {
            pins.insert(previous.generation.clone());
        }
        if let Some(candidate) = &self.candidate {
            pins.insert(candidate.generation.clone());
        }
        pins
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum KernelEvent {
    BeginCrashRecovery {
        transaction_id: String,
        nonce: String,
        source_hub_epoch: u64,
    },
    BeginRollback {
        transaction_id: String,
        nonce: String,
        source_hub_epoch: u64,
        artifact: ArtifactIdentity,
    },
    StageCandidate {
        transaction_id: String,
        nonce: String,
        kind: TransactionKind,
        source_hub_epoch: Option<u64>,
        artifact: ArtifactIdentity,
    },
    PreflightPassed,
    BeginDrain,
    DrainReady {
        run_set_digest: String,
        generation_pins: BTreeSet<String>,
    },
    OldExited,
    BeginRecovery,
    ActivationPrepared {
        receipt_id: String,
        run_set_digest: String,
    },
    LocalCommit,
    ActiveFenced {
        receipt_id: String,
    },
    BeginProbation,
    HubActive {
        receipt_id: String,
    },
    PersistStable,
    StableGranted,
    CompleteStable {
        hub_epoch: u64,
    },
    RecordStableEpoch(u64),
    AbortBeforeCommit,
    Degrade,
}

pub struct ActivationKernel {
    payload: JournalPayload,
}

impl ActivationKernel {
    pub fn new(payload: JournalPayload) -> Result<Self, ContinuityError> {
        payload.validate()?;
        Ok(Self { payload })
    }

    pub fn payload(&self) -> &JournalPayload {
        &self.payload
    }

    pub fn admission_open(&self) -> bool {
        self.payload
            .transaction
            .as_ref()
            .is_none_or(|transaction| transaction.phase == ActivationPhase::StableGranted)
    }

    pub fn apply(&mut self, event: KernelEvent) -> Result<&JournalPayload, ContinuityError> {
        match event {
            KernelEvent::BeginRollback {
                transaction_id,
                nonce,
                source_hub_epoch,
                artifact,
            } => {
                let failed = self
                    .payload
                    .transaction
                    .as_ref()
                    .ok_or(ContinuityError::Invalid(
                        "rollback has no failed transaction",
                    ))?
                    .target_sha256
                    .clone();
                artifact.validate()?;
                let allowed = artifact.sha256 == self.payload.committed.sha256
                    || self
                        .payload
                        .previous
                        .as_ref()
                        .is_some_and(|previous| previous.sha256 == artifact.sha256);
                if !allowed || source_hub_epoch == 0 || nonce.len() < 32 {
                    return Err(ContinuityError::Invalid("rollback target is not exact LKG"));
                }
                insert_bounded_quarantine(&mut self.payload.quarantined_sha256, failed);
                self.payload.candidate = Some(artifact.clone());
                self.payload.transaction = Some(ActivationTransaction {
                    id: transaction_id,
                    nonce,
                    kind: TransactionKind::Rollback,
                    phase: ActivationPhase::Recovering,
                    source_sha256: self.payload.committed.sha256.clone(),
                    target_sha256: artifact.sha256,
                    run_set_digest: None,
                    hub_receipt_ids: BTreeMap::new(),
                    attempt: 1,
                    source_hub_epoch: Some(source_hub_epoch),
                });
            }
            KernelEvent::BeginCrashRecovery {
                transaction_id,
                nonce,
                source_hub_epoch,
            } => {
                if self.payload.transaction.is_some() || source_hub_epoch == 0 {
                    return Err(ContinuityError::Invalid(
                        "crash recovery identity or source Hub epoch is invalid",
                    ));
                }
                self.payload.transaction = Some(ActivationTransaction {
                    id: transaction_id,
                    nonce,
                    kind: TransactionKind::CrashRecovery,
                    phase: ActivationPhase::Recovering,
                    source_sha256: self.payload.committed.sha256.clone(),
                    target_sha256: self.payload.committed.sha256.clone(),
                    run_set_digest: None,
                    hub_receipt_ids: BTreeMap::new(),
                    attempt: 1,
                    source_hub_epoch: Some(source_hub_epoch),
                });
            }
            KernelEvent::StageCandidate {
                transaction_id,
                nonce,
                kind,
                source_hub_epoch,
                artifact,
            } => {
                if self.payload.transaction.is_some() || self.payload.candidate.is_some() {
                    return Err(ContinuityError::Invalid(
                        "activation writer is already busy",
                    ));
                }
                artifact.validate()?;
                if artifact.release_sequence < self.payload.committed.release_sequence
                    || self.payload.quarantined_sha256.contains(&artifact.sha256)
                {
                    return Err(ContinuityError::Invalid(
                        "candidate violates release floor or quarantine",
                    ));
                }
                self.payload.candidate = Some(artifact.clone());
                self.payload.transaction = Some(ActivationTransaction {
                    id: transaction_id,
                    nonce,
                    kind,
                    phase: ActivationPhase::CandidateStaged,
                    source_sha256: self.payload.committed.sha256.clone(),
                    target_sha256: artifact.sha256,
                    run_set_digest: None,
                    hub_receipt_ids: BTreeMap::new(),
                    attempt: 1,
                    source_hub_epoch,
                });
            }
            KernelEvent::ActivationPrepared {
                receipt_id,
                run_set_digest,
            } => {
                let transaction = self.transaction_mut()?;
                transaction.advance(ActivationPhase::ActivationPrepared)?;
                transaction.run_set_digest = Some(run_set_digest);
                transaction
                    .hub_receipt_ids
                    .insert("activationPrepared".into(), receipt_id);
            }
            KernelEvent::ActiveFenced { receipt_id } => {
                let transaction = self.transaction_mut()?;
                transaction.advance(ActivationPhase::ActiveFenced)?;
                transaction
                    .hub_receipt_ids
                    .insert("activeFenced".into(), receipt_id);
            }
            KernelEvent::HubActive { receipt_id } => {
                let transaction = self.transaction_mut()?;
                transaction.advance(ActivationPhase::HubActive)?;
                transaction
                    .hub_receipt_ids
                    .insert("active".into(), receipt_id);
            }
            KernelEvent::LocalCommit => {
                self.transaction_mut()?
                    .advance(ActivationPhase::LocalCommitted)?;
                if let Some(candidate) = self.payload.candidate.take() {
                    self.payload.previous =
                        Some(std::mem::replace(&mut self.payload.committed, candidate));
                } else if self
                    .payload
                    .transaction
                    .as_ref()
                    .is_none_or(|transaction| transaction.kind != TransactionKind::CrashRecovery)
                {
                    return Err(ContinuityError::Invalid("local commit has no candidate"));
                }
            }
            KernelEvent::AbortBeforeCommit => {
                let phase = self.transaction_mut()?.phase;
                if matches!(
                    phase,
                    ActivationPhase::LocalCommitted
                        | ActivationPhase::ActiveFenced
                        | ActivationPhase::Probation
                        | ActivationPhase::HubActive
                        | ActivationPhase::StablePersisted
                        | ActivationPhase::StableGranted
                ) {
                    return Err(ContinuityError::Invalid(
                        "post-commit transaction cannot abort",
                    ));
                }
                let candidate = self.payload.candidate.take();
                if let Some(candidate) = candidate {
                    self.payload.generation_pins.remove(&candidate.generation);
                }
                self.payload.transaction = None;
            }
            KernelEvent::StableGranted => {
                self.transaction_mut()?
                    .advance(ActivationPhase::StableGranted)?;
            }
            KernelEvent::CompleteStable { hub_epoch } => {
                if hub_epoch == 0 {
                    return Err(ContinuityError::Invalid("stable Hub epoch is invalid"));
                }
                self.transaction_mut()?.advance(ActivationPhase::Stable)?;
                self.payload.transaction = None;
                self.payload.last_hub_epoch = Some(hub_epoch);
            }
            KernelEvent::RecordStableEpoch(epoch) => {
                if epoch == 0 || self.payload.transaction.is_some() {
                    return Err(ContinuityError::Invalid(
                        "stable Hub epoch cannot be recorded during activation",
                    ));
                }
                self.payload.last_hub_epoch = Some(epoch);
            }
            KernelEvent::PreflightPassed => self.advance(ActivationPhase::PreflightPassed)?,
            KernelEvent::BeginDrain => self.advance(ActivationPhase::Draining)?,
            KernelEvent::DrainReady {
                run_set_digest,
                generation_pins,
            } => {
                let transaction = self.transaction_mut()?;
                if transaction.phase != ActivationPhase::Draining
                    || run_set_digest.len() != 64
                    || !run_set_digest
                        .bytes()
                        .all(|value| value.is_ascii_hexdigit())
                {
                    return Err(ContinuityError::Invalid(
                        "drain Run-set evidence is invalid",
                    ));
                }
                if generation_pins
                    .iter()
                    .any(|value| !is_safe_generation_name(value))
                {
                    return Err(ContinuityError::Invalid("generation pin is invalid"));
                }
                transaction.run_set_digest = Some(run_set_digest);
                self.payload.generation_pins = generation_pins;
            }
            KernelEvent::OldExited => {
                if self.transaction_mut()?.run_set_digest.is_none() {
                    return Err(ContinuityError::RunSetIncomplete);
                }
                self.advance(ActivationPhase::OldExited)?;
            }
            KernelEvent::BeginRecovery => self.advance(ActivationPhase::Recovering)?,
            KernelEvent::BeginProbation => self.advance(ActivationPhase::Probation)?,
            KernelEvent::PersistStable => self.advance(ActivationPhase::StablePersisted)?,
            KernelEvent::Degrade => self.advance(ActivationPhase::Degraded)?,
        }
        self.payload.revision = self.payload.revision.saturating_add(1);
        self.payload.validate()?;
        Ok(&self.payload)
    }

    fn transaction_mut(&mut self) -> Result<&mut ActivationTransaction, ContinuityError> {
        self.payload
            .transaction
            .as_mut()
            .ok_or(ContinuityError::Invalid(
                "activation transaction is missing",
            ))
    }

    fn advance(&mut self, phase: ActivationPhase) -> Result<(), ContinuityError> {
        self.transaction_mut()?.advance(phase)
    }
}

pub fn insert_bounded_quarantine(quarantine: &mut BTreeSet<String>, digest: String) {
    if quarantine.contains(&digest) {
        return;
    }
    while quarantine.len() >= MAX_QUARANTINED_ARTIFACTS {
        quarantine.pop_first();
    }
    quarantine.insert(digest);
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JournalEnvelope {
    payload: JournalPayload,
    checksum_sha256: String,
}

pub struct ActivationJournal {
    path: PathBuf,
}

impl ActivationJournal {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn load(&self) -> Result<JournalPayload, ContinuityError> {
        load_with_previous_image(&self.path, |path| self.load_path(path))
    }

    fn load_path(&self, path: &Path) -> Result<JournalPayload, ContinuityError> {
        let bytes = read_bounded(path, MAX_CONTROL_FRAME_BYTES)?;
        let envelope: JournalEnvelope = serde_json::from_slice(&bytes)?;
        verify_payload_checksum(&envelope.payload, &envelope.checksum_sha256)?;
        envelope.payload.validate()?;
        Ok(envelope.payload)
    }

    pub fn store(&self, payload: &JournalPayload) -> Result<(), ContinuityError> {
        payload.validate()?;
        let envelope = JournalEnvelope {
            payload: payload.clone(),
            checksum_sha256: payload_checksum(payload)?,
        };
        store_with_previous_image(&self.path, &envelope, || self.load_path(&self.path).is_ok())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunEvidence {
    pub run_id: String,
    pub execution_key: String,
    pub instance_id: String,
    pub pid: u32,
    pub process_birth_id: u64,
    pub executable_sha256: String,
    pub wrapper_nonce: String,
    pub adoption_key_hash: String,
    pub job_name: String,
    pub protocol_major: u16,
    pub executable_path: PathBuf,
    pub adoption_public_key: String,
    pub control_locator: String,
}

impl RunEvidence {
    pub fn validate(&self) -> Result<(), ContinuityError> {
        if self.run_id.trim().is_empty()
            || self.execution_key.trim().is_empty()
            || self.instance_id.trim().is_empty()
            || self.pid == 0
            || self.process_birth_id == 0
            || self.wrapper_nonce.len() < 32
            || self.adoption_key_hash.len() != 64
            || self.executable_sha256.len() != 64
            || self.protocol_major != SUPERVISOR_PROTOCOL_MAJOR
            || self.job_name.trim().is_empty()
            || self.adoption_public_key.trim().is_empty()
            || self.control_locator.trim().is_empty()
        {
            return Err(ContinuityError::Invalid(
                "Run adoption evidence is incomplete",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunAccounting {
    pub expected: BTreeSet<String>,
    pub adopted: BTreeMap<String, RunEvidence>,
    pub natural_terminal: BTreeSet<String>,
    pub quarantined: BTreeSet<String>,
}

impl RunAccounting {
    pub fn validate_complete(&self) -> Result<String, ContinuityError> {
        if !self.quarantined.is_empty() {
            return Err(ContinuityError::RunConflict);
        }
        let accounted = self
            .adopted
            .keys()
            .cloned()
            .chain(self.natural_terminal.iter().cloned())
            .collect::<BTreeSet<_>>();
        if accounted != self.expected {
            return Err(ContinuityError::RunSetIncomplete);
        }
        for (run_id, evidence) in &self.adopted {
            evidence.validate()?;
            if run_id != &evidence.run_id {
                return Err(ContinuityError::RunConflict);
            }
        }
        let bytes =
            serde_json::to_vec(&(self.expected.clone(), &self.adopted, &self.natural_terminal))?;
        Ok(hex_sha256(&bytes))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EffectPhase {
    Received,
    Admitted,
    EffectCommitted,
    HubCompletionAcked,
    Quarantined,
}

fn process_monotonic_millis() -> u64 {
    static ORIGIN: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    ORIGIN
        .get_or_init(std::time::Instant::now)
        .elapsed()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandEffect {
    pub control_id: String,
    pub command_type: String,
    pub payload_digest: String,
    pub phase: EffectPhase,
    pub result_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    /// Process-monotonic timing evidence. These values are deliberately not
    /// wall clocks: subtracting two values recorded by the same daemon process
    /// gives an admission/effect duration that cannot jump with NTP. A replay
    /// after process restart may leave a later field absent and Hub remains the
    /// cross-process wall-clock authority.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub received_monotonic_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub admitted_monotonic_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effect_committed_monotonic_ms: Option<u64>,
}

impl CommandEffect {
    pub fn stable_id(&self) -> String {
        hex_sha256(
            format!(
                "{}\0{}\0{}",
                self.control_id, self.command_type, self.payload_digest
            )
            .as_bytes(),
        )
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EffectJournalPayload {
    schema: u32,
    revision: u64,
    effects: BTreeMap<String, CommandEffect>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EffectJournalEnvelope {
    payload: EffectJournalPayload,
    checksum_sha256: String,
}

pub struct CommandEffectJournal {
    path: PathBuf,
}

impl CommandEffectJournal {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn effect_for_control_id(
        &self,
        control_id: &str,
    ) -> Result<Option<CommandEffect>, ContinuityError> {
        let payload = self.load_or_empty()?;
        Ok(payload
            .effects
            .values()
            .find(|effect| effect.control_id == control_id)
            .cloned())
    }

    pub fn receive(
        &self,
        control_id: &str,
        command_type: &str,
        payload_digest: &str,
    ) -> Result<CommandEffect, ContinuityError> {
        if control_id.trim().is_empty()
            || command_type.trim().is_empty()
            || payload_digest.len() != 64
        {
            return Err(ContinuityError::Invalid(
                "command effect identity is invalid",
            ));
        }
        let mut payload = self.load_or_empty()?;
        let candidate = CommandEffect {
            control_id: control_id.to_string(),
            command_type: command_type.to_string(),
            payload_digest: payload_digest.to_string(),
            phase: EffectPhase::Received,
            result_digest: None,
            result: None,
            received_monotonic_ms: Some(process_monotonic_millis()),
            admitted_monotonic_ms: None,
            effect_committed_monotonic_ms: None,
        };
        let stable_id = candidate.stable_id();
        if let Some(existing) = payload.effects.get(&stable_id) {
            return Ok(existing.clone());
        }
        if payload
            .effects
            .values()
            .any(|effect| effect.control_id == control_id)
        {
            return Err(ContinuityError::RunConflict);
        }
        payload.effects.insert(stable_id, candidate.clone());
        payload.revision = payload.revision.saturating_add(1);
        self.store(&payload)?;
        Ok(candidate)
    }

    /// Re-key a command that has not produced a physical effect yet to the
    /// payload digest this CLI computes for it.
    ///
    /// The digest is taken over the command as the receiving CLI serializes
    /// it, so the same redelivered command hashes differently once a daemon
    /// self-update changes the command's fields. A Received or Admitted effect
    /// is re-executed on redelivery anyway, so re-keying it keeps the command
    /// alive across the update instead of stranding its Run. A committed or
    /// quarantined effect is never re-keyed.
    pub fn rekey_unexecuted(
        &self,
        control_id: &str,
        command_type: &str,
        payload_digest: &str,
    ) -> Result<CommandEffect, ContinuityError> {
        if payload_digest.len() != 64 {
            return Err(ContinuityError::Invalid(
                "command effect identity is invalid",
            ));
        }
        let mut payload = self.load_or_empty()?;
        let (stable_id, existing) = payload
            .effects
            .iter()
            .find(|(_, effect)| effect.control_id == control_id)
            .map(|(id, effect)| (id.clone(), effect.clone()))
            .ok_or(ContinuityError::Invalid("command effect is missing"))?;
        if existing.command_type != command_type
            || !matches!(
                existing.phase,
                EffectPhase::Received | EffectPhase::Admitted
            )
        {
            return Err(ContinuityError::RunConflict);
        }
        let rekeyed = CommandEffect {
            payload_digest: payload_digest.to_string(),
            ..existing
        };
        payload.effects.remove(&stable_id);
        payload.effects.insert(rekeyed.stable_id(), rekeyed.clone());
        payload.revision = payload.revision.saturating_add(1);
        self.store(&payload)?;
        Ok(rekeyed)
    }

    pub fn admit(&self, stable_id: &str) -> Result<CommandEffect, ContinuityError> {
        self.transition(stable_id, EffectPhase::Admitted, None)
    }

    pub fn commit_result(
        &self,
        stable_id: &str,
        result: serde_json::Value,
    ) -> Result<CommandEffect, ContinuityError> {
        let digest = hex_sha256(&serde_json::to_vec(&result)?);
        self.transition(
            stable_id,
            EffectPhase::EffectCommitted,
            Some((digest, result)),
        )
    }

    /// Replace only the transport envelope of an already committed effect
    /// before replaying it under a newly claimed Authority lease. The caller
    /// must provide the digest it observed, so an unrelated concurrent rewrite
    /// cannot silently change durable physical-effect evidence.
    pub fn rebind_committed_result(
        &self,
        stable_id: &str,
        expected_result_digest: &str,
        result: serde_json::Value,
    ) -> Result<CommandEffect, ContinuityError> {
        let mut payload = self.load_or_empty()?;
        let effect = payload
            .effects
            .get_mut(stable_id)
            .ok_or(ContinuityError::Invalid("command effect is missing"))?;
        if effect.phase != EffectPhase::EffectCommitted {
            return Err(ContinuityError::Invalid(
                "only a committed command effect can be rebound",
            ));
        }
        let digest = hex_sha256(&serde_json::to_vec(&result)?);
        if effect.result_digest.as_deref() == Some(digest.as_str()) {
            return Ok(effect.clone());
        }
        if effect.result_digest.as_deref() != Some(expected_result_digest) {
            return Err(ContinuityError::RunConflict);
        }
        effect.result_digest = Some(digest);
        effect.result = Some(result);
        let rebound = effect.clone();
        payload.revision = payload.revision.saturating_add(1);
        self.store(&payload)?;
        Ok(rebound)
    }

    pub fn acknowledge(&self, control_id: &str) -> Result<CommandEffect, ContinuityError> {
        let payload = self.load_or_empty()?;
        let stable_id = payload
            .effects
            .iter()
            .find_map(|(id, effect)| (effect.control_id == control_id).then_some(id.clone()))
            .ok_or(ContinuityError::Invalid("command effect is missing"))?;
        drop(payload);
        let acknowledged = self.transition(&stable_id, EffectPhase::HubCompletionAcked, None)?;
        let mut payload = self.load_or_empty()?;
        if payload.effects.len() > 16 {
            let remove = payload
                .effects
                .iter()
                .filter_map(|(id, effect)| {
                    (effect.phase == EffectPhase::HubCompletionAcked).then_some(id.clone())
                })
                .take(payload.effects.len() - 16)
                .collect::<Vec<_>>();
            for id in remove {
                payload.effects.remove(&id);
            }
            payload.revision = payload.revision.saturating_add(1);
            self.store(&payload)?;
        }
        Ok(acknowledged)
    }

    pub fn phase_counts(&self) -> Result<BTreeMap<String, usize>, ContinuityError> {
        let payload = self.load_or_empty()?;
        let mut counts = BTreeMap::new();
        for effect in payload.effects.values() {
            *counts.entry(format!("{:?}", effect.phase)).or_insert(0) += 1;
        }
        Ok(counts)
    }

    pub fn pending_completion_results(&self) -> Result<Vec<serde_json::Value>, ContinuityError> {
        self.load_or_empty()?
            .effects
            .into_values()
            .filter(|effect| effect.phase == EffectPhase::EffectCommitted)
            .map(|effect| {
                effect.result.ok_or(ContinuityError::Invalid(
                    "committed command effect has no result",
                ))
            })
            .collect()
    }

    fn transition(
        &self,
        stable_id: &str,
        next: EffectPhase,
        result: Option<(String, serde_json::Value)>,
    ) -> Result<CommandEffect, ContinuityError> {
        let mut payload = self.load_or_empty()?;
        let effect = payload
            .effects
            .get_mut(stable_id)
            .ok_or(ContinuityError::Invalid("command effect is missing"))?;
        let valid = effect.phase == next
            || matches!(
                (effect.phase, next),
                (EffectPhase::Received, EffectPhase::Admitted)
                    | (EffectPhase::Admitted, EffectPhase::EffectCommitted)
                    | (
                        EffectPhase::EffectCommitted,
                        EffectPhase::HubCompletionAcked
                    )
            );
        if !valid {
            return Err(ContinuityError::Invalid(
                "command effect transition is invalid",
            ));
        }
        if effect.phase != next {
            effect.phase = next;
            if next == EffectPhase::Admitted {
                effect.admitted_monotonic_ms = Some(process_monotonic_millis());
            } else if next == EffectPhase::EffectCommitted {
                effect.effect_committed_monotonic_ms = Some(process_monotonic_millis());
            }
            if let Some((digest, value)) = result {
                effect.result_digest = Some(digest);
                effect.result = Some(value);
            }
            payload.revision = payload.revision.saturating_add(1);
            self.store(&payload)?;
        }
        Ok(payload
            .effects
            .get(stable_id)
            .expect("effect remains")
            .clone())
    }

    fn load_or_empty(&self) -> Result<EffectJournalPayload, ContinuityError> {
        match read_bounded(&self.path, MAX_EFFECT_JOURNAL_BYTES) {
            Ok(bytes) => {
                let envelope: EffectJournalEnvelope = serde_json::from_slice(&bytes)?;
                verify_payload_checksum(&envelope.payload, &envelope.checksum_sha256)?;
                Ok(envelope.payload)
            }
            Err(ContinuityError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(EffectJournalPayload {
                    schema: JOURNAL_SCHEMA,
                    revision: 1,
                    effects: BTreeMap::new(),
                })
            }
            Err(error) => Err(error),
        }
    }

    fn store(&self, payload: &EffectJournalPayload) -> Result<(), ContinuityError> {
        let envelope = EffectJournalEnvelope {
            checksum_sha256: payload_checksum(payload)?,
            payload: payload.clone(),
        };
        let bytes = serde_json::to_vec_pretty(&envelope)?;
        if bytes.len() > MAX_EFFECT_JOURNAL_BYTES {
            return Err(ContinuityError::FrameTooLarge(bytes.len()));
        }
        atomic_replace(&self.path, &bytes)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ControlMessage {
    Hello {
        protocol_major: u16,
        nonce: String,
    },
    StageCandidate {
        transaction_id: String,
        nonce: String,
        source_hub_epoch: u64,
        artifact: ArtifactIdentity,
    },
    BeginDrain {
        transaction_id: String,
        nonce: String,
    },
    DrainReady {
        transaction_id: String,
        nonce: String,
        run_set_digest: String,
        generation_pins: BTreeSet<String>,
    },
    AbortDrain {
        transaction_id: String,
        nonce: String,
        reason: String,
    },
    DrainAborted {
        transaction_id: String,
        nonce: String,
    },
    CommitExit {
        transaction_id: String,
        nonce: String,
    },
    RecoveryReceipt {
        transaction_id: String,
        nonce: String,
        hub_epoch: u64,
        run_set_digest: String,
    },
    HubActivationReceipt {
        transaction_id: String,
        nonce: String,
        hub_epoch: u64,
        phase: String,
        receipt_id: String,
        run_set_digest: Option<String>,
        prepared_receipt_id: Option<String>,
        active_fenced_receipt_id: Option<String>,
        active_receipt_id: Option<String>,
    },
    LocalCommitted {
        transaction_id: String,
        nonce: String,
    },
    StableReady {
        hub_epoch: u64,
    },
    WrapperObserved {
        nonce: String,
        evidence: RunEvidence,
    },
    LaunchAuthorized {
        nonce: String,
    },
    BootPreflightReady {
        nonce: String,
    },
    BootCommitGranted {
        nonce: String,
    },
    BootStable {
        nonce: String,
    },
    StableGranted {
        transaction_id: String,
        nonce: String,
    },
    FailClosed {
        transaction_id: Option<String>,
        reason: String,
    },
}

pub fn encode_frame(message: &ControlMessage) -> Result<Vec<u8>, ContinuityError> {
    let payload = serde_json::to_vec(message)?;
    if payload.len() > MAX_CONTROL_FRAME_BYTES {
        return Err(ContinuityError::FrameTooLarge(payload.len()));
    }
    let mut frame = Vec::with_capacity(payload.len() + 4);
    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.extend_from_slice(&payload);
    Ok(frame)
}

pub fn decode_frame(reader: &mut impl Read) -> Result<ControlMessage, ContinuityError> {
    let mut header = [0u8; 4];
    reader.read_exact(&mut header)?;
    let len = u32::from_be_bytes(header) as usize;
    if len > MAX_CONTROL_FRAME_BYTES {
        return Err(ContinuityError::FrameTooLarge(len));
    }
    let mut payload = vec![0u8; len];
    reader.read_exact(&mut payload)?;
    Ok(serde_json::from_slice(&payload)?)
}

pub fn sha256_file(path: &Path) -> Result<String, ContinuityError> {
    let mut file = File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(digest
        .finalize()
        .iter()
        .map(|value| format!("{value:02x}"))
        .collect())
}

pub fn current_unix_time() -> Result<u64, ContinuityError> {
    Ok(std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| ContinuityError::Invalid("system clock precedes the Unix epoch"))?
        .as_secs())
}

pub fn validate_release_envelope_payload(
    payload: &ReleaseEnvelopePayload,
    artifact: &ArtifactIdentity,
    actual_size: u64,
    now_unix: u64,
    committed_sequence: u64,
    allow_expired_lkg: bool,
) -> Result<(), ContinuityError> {
    artifact.validate()?;
    if payload.workflow != "cli-release.yml"
        || payload.run_id == 0
        || payload.run_attempt == 0
        || payload.git_sha.len() != 40
        || !payload
            .git_sha
            .bytes()
            .all(|value| value.is_ascii_hexdigit())
        || payload.provenance.trim().is_empty()
        || payload.publisher != artifact.publisher_sha256
        || payload.target != artifact.target
        || payload.sha256 != artifact.sha256
        || payload.size != actual_size
        || payload.release_sequence != artifact.release_sequence
        || payload.protocol_min != artifact.protocol_min
        || payload.protocol_max != artifact.protocol_max
        || (!allow_expired_lkg && payload.expires_at_unix < now_unix)
        || payload.release_sequence < payload.rollback_floor
        || payload.release_sequence < committed_sequence
    {
        return Err(ContinuityError::Invalid(
            "signed release envelope does not authorize candidate",
        ));
    }
    Ok(())
}

#[cfg(windows)]
pub fn verify_signed_artifact(
    artifact: &ArtifactIdentity,
    now_unix: u64,
    committed_sequence: u64,
    expected_publisher: Option<&str>,
    allow_expired_lkg: bool,
) -> Result<(), ContinuityError> {
    artifact.validate()?;
    let executable_publisher = verify_authenticode_publisher(&artifact.executable_path)?;
    let envelope_publisher = verify_authenticode_publisher(&artifact.release_envelope_path)?;
    if executable_publisher != envelope_publisher
        || executable_publisher != artifact.publisher_sha256
        || expected_publisher.is_some_and(|value| value != executable_publisher)
        || sha256_file(&artifact.executable_path)? != artifact.sha256
        || sha256_file(&artifact.release_envelope_path)? != artifact.release_envelope_sha256
    {
        return Err(ContinuityError::Invalid(
            "artifact publisher, digest, or signed envelope identity changed",
        ));
    }
    let envelope = read_embedded_release_envelope(&artifact.release_envelope_path)?;
    let actual_size = fs::metadata(&artifact.executable_path)?.len();
    validate_release_envelope_payload(
        &envelope.payload,
        artifact,
        actual_size,
        now_unix,
        committed_sequence,
        allow_expired_lkg,
    )
}

#[cfg(windows)]
pub fn verify_authenticode_publisher(path: &Path) -> Result<String, ContinuityError> {
    use std::mem::size_of;
    use std::os::windows::ffi::OsStrExt as _;
    use windows_sys::Win32::Security::WinTrust::{
        WINTRUST_ACTION_GENERIC_VERIFY_V2, WINTRUST_DATA, WINTRUST_DATA_0, WINTRUST_FILE_INFO,
        WTD_CHOICE_FILE, WTD_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT, WTD_REVOKE_WHOLECHAIN,
        WTD_STATEACTION_CLOSE, WTD_STATEACTION_VERIFY, WTD_UI_NONE, WTHelperGetProvCertFromChain,
        WTHelperGetProvSignerFromChain, WTHelperProvDataFromStateData, WinVerifyTrust,
    };

    #[cfg(debug_assertions)]
    if std::env::var("XMATRIX_TEST_ALLOW_UNSIGNED_CONTINUITY")
        .ok()
        .as_deref()
        == Some("1")
    {
        return Ok(
            std::env::var("XMATRIX_TEST_PUBLISHER_SHA256").unwrap_or_else(|_| "0".repeat(64))
        );
    }
    let mut wide = path.as_os_str().encode_wide().collect::<Vec<_>>();
    wide.push(0);
    let mut file = WINTRUST_FILE_INFO {
        cbStruct: size_of::<WINTRUST_FILE_INFO>() as u32,
        pcwszFilePath: wide.as_ptr(),
        hFile: std::ptr::null_mut(),
        pgKnownSubject: std::ptr::null_mut(),
    };
    let mut data = WINTRUST_DATA {
        cbStruct: size_of::<WINTRUST_DATA>() as u32,
        pPolicyCallbackData: std::ptr::null_mut(),
        pSIPClientData: std::ptr::null_mut(),
        dwUIChoice: WTD_UI_NONE,
        fdwRevocationChecks: WTD_REVOKE_WHOLECHAIN,
        dwUnionChoice: WTD_CHOICE_FILE,
        Anonymous: WINTRUST_DATA_0 { pFile: &mut file },
        dwStateAction: WTD_STATEACTION_VERIFY,
        hWVTStateData: std::ptr::null_mut(),
        pwszURLReference: std::ptr::null_mut(),
        dwProvFlags: WTD_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT,
        dwUIContext: 0,
        pSignatureSettings: std::ptr::null_mut(),
    };
    let mut policy = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    let status = unsafe {
        WinVerifyTrust(
            std::ptr::null_mut(),
            &mut policy,
            (&mut data as *mut WINTRUST_DATA).cast(),
        )
    };
    if status != 0 {
        data.dwStateAction = WTD_STATEACTION_CLOSE;
        let _ = unsafe {
            WinVerifyTrust(
                std::ptr::null_mut(),
                &mut policy,
                (&mut data as *mut WINTRUST_DATA).cast(),
            )
        };
        return Err(ContinuityError::Invalid(
            "artifact Authenticode verification failed",
        ));
    }
    let identity = unsafe {
        let provider = WTHelperProvDataFromStateData(data.hWVTStateData);
        if provider.is_null() {
            None
        } else {
            let signer = WTHelperGetProvSignerFromChain(provider, 0, 0, 0);
            if signer.is_null() {
                None
            } else {
                let certificate = WTHelperGetProvCertFromChain(signer, 0);
                if certificate.is_null() || (*certificate).pCert.is_null() {
                    None
                } else {
                    let context = &*(*certificate).pCert;
                    if context.pbCertEncoded.is_null() || context.cbCertEncoded == 0 {
                        None
                    } else {
                        Some(hex_sha256(std::slice::from_raw_parts(
                            context.pbCertEncoded,
                            context.cbCertEncoded as usize,
                        )))
                    }
                }
            }
        }
    };
    data.dwStateAction = WTD_STATEACTION_CLOSE;
    let _ = unsafe {
        WinVerifyTrust(
            std::ptr::null_mut(),
            &mut policy,
            (&mut data as *mut WINTRUST_DATA).cast(),
        )
    };
    identity.ok_or(ContinuityError::Invalid(
        "artifact Authenticode publisher identity is missing",
    ))
}

#[derive(Debug)]
pub enum ContinuityError {
    Io(std::io::Error),
    Json(serde_json::Error),
    Invalid(&'static str),
    InvalidTransition(ActivationPhase, ActivationPhase),
    ChecksumMismatch,
    FrameTooLarge(usize),
    RunConflict,
    RunSetIncomplete,
    ReplayRejected,
}

impl std::fmt::Display for ContinuityError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "continuity I/O error: {error}"),
            Self::Json(error) => write!(formatter, "continuity JSON error: {error}"),
            Self::Invalid(reason) => write!(formatter, "invalid continuity evidence: {reason}"),
            Self::InvalidTransition(from, to) => write!(
                formatter,
                "invalid activation transition {from:?} -> {to:?}"
            ),
            Self::ChecksumMismatch => write!(formatter, "activation journal checksum mismatch"),
            Self::FrameTooLarge(size) => write!(formatter, "continuity frame is too large: {size}"),
            Self::RunConflict => write!(formatter, "Run evidence is quarantined or conflicting"),
            Self::RunSetIncomplete => {
                write!(formatter, "expected Run set is not completely accounted")
            }
            Self::ReplayRejected => {
                write!(formatter, "control frame nonce or sequence was rejected")
            }
        }
    }
}

impl std::error::Error for ContinuityError {}

impl From<std::io::Error> for ContinuityError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<serde_json::Error> for ContinuityError {
    fn from(value: serde_json::Error) -> Self {
        Self::Json(value)
    }
}

fn load_with_previous_image<T>(
    path: &Path,
    load: impl Fn(&Path) -> Result<T, ContinuityError>,
) -> Result<T, ContinuityError> {
    load(path).or_else(|primary_error| load(&previous_image_path(path)).map_err(|_| primary_error))
}

fn store_with_previous_image(
    path: &Path,
    envelope: &impl Serialize,
    primary_valid: impl FnOnce() -> bool,
) -> Result<(), ContinuityError> {
    let bytes = serde_json::to_vec_pretty(envelope)?;
    if bytes.len() > MAX_CONTROL_FRAME_BYTES {
        return Err(ContinuityError::FrameTooLarge(bytes.len()));
    }
    if let Ok(existing) = read_bounded(path, MAX_CONTROL_FRAME_BYTES)
        && primary_valid()
    {
        atomic_replace(&previous_image_path(path), &existing)?;
    }
    atomic_replace(path, &bytes)
}

/// Read a required process argument used by continuity entrypoints.
pub fn required_process_argument(flag: &str) -> Result<String, Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    while let Some(value) = args.next() {
        if value == flag {
            return args
                .next()
                .ok_or_else(|| format!("missing value for {flag}").into());
        }
    }
    Err(format!("missing required {flag}").into())
}

fn verify_payload_checksum(
    payload: &impl Serialize,
    checksum: &str,
) -> Result<(), ContinuityError> {
    let expected = payload_checksum(payload)?;
    if !constant_time_eq(expected.as_bytes(), checksum.as_bytes()) {
        return Err(ContinuityError::ChecksumMismatch);
    }
    Ok(())
}

fn payload_checksum(payload: &impl Serialize) -> Result<String, ContinuityError> {
    Ok(hex_sha256(&serde_json::to_vec(payload)?))
}

fn hex_sha256(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|value| format!("{value:02x}")).collect()
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0u8, |diff, (a, b)| diff | (a ^ b))
        == 0
}

pub fn is_safe_generation_name(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && value.bytes().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, b'.' | b'-' | b'_')
        })
}

fn read_bounded(path: &Path, limit: usize) -> Result<Vec<u8>, ContinuityError> {
    let file = File::open(path)?;
    if file.metadata()?.len() > limit as u64 {
        return Err(ContinuityError::FrameTooLarge(
            file.metadata()?.len() as usize
        ));
    }
    let mut bytes = Vec::new();
    file.take((limit + 1) as u64).read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return Err(ContinuityError::FrameTooLarge(bytes.len()));
    }
    Ok(bytes)
}

fn previous_image_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("journal");
    path.with_file_name(format!("{name}.previous"))
}

fn atomic_replace(path: &Path, bytes: &[u8]) -> Result<(), ContinuityError> {
    let parent = path
        .parent()
        .ok_or(ContinuityError::Invalid("journal has no parent"))?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|v| v.to_str())
            .unwrap_or("journal"),
        uuid::Uuid::new_v4().simple()
    ));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    replace_path(&temporary, path)?;
    sync_parent(parent)?;
    Ok(())
}

#[cfg(not(windows))]
fn sync_parent(parent: &Path) -> Result<(), ContinuityError> {
    File::open(parent)?.sync_all()?;
    Ok(())
}

#[cfg(windows)]
fn sync_parent(_parent: &Path) -> Result<(), ContinuityError> {
    Ok(())
}

#[cfg(not(windows))]
fn replace_path(source: &Path, destination: &Path) -> Result<(), ContinuityError> {
    fs::rename(source, destination)?;
    Ok(())
}

#[cfg(windows)]
fn replace_path(source: &Path, destination: &Path) -> Result<(), ContinuityError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };
    let source = source
        .as_os_str()
        .encode_wide()
        .chain([0])
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain([0])
        .collect::<Vec<_>>();
    if unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(ContinuityError::Io(std::io::Error::last_os_error()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_journal_payload(committed: ArtifactIdentity) -> JournalPayload {
        JournalPayload {
            schema: JOURNAL_SCHEMA,
            revision: 1,
            committed,
            previous: None,
            candidate: None,
            transaction: None,
            quarantined_sha256: BTreeSet::new(),
            generation_pins: BTreeSet::new(),
            last_hub_epoch: None,
        }
    }

    fn artifact(name: &str, digest: char) -> ArtifactIdentity {
        ArtifactIdentity {
            generation: name.into(),
            sha256: digest.to_string().repeat(64),
            executable_path: PathBuf::from(format!("generations/{name}/xmatrix.exe")),
            release_envelope_path: PathBuf::from(format!(
                "generations/{name}/release-envelope.exe"
            )),
            release_envelope_sha256: "e".repeat(64),
            publisher_sha256: "f".repeat(64),
            version: "0.16.128".into(),
            target: "x86_64-pc-windows-msvc".into(),
            release_sequence: release_sequence_from_version("0.16.128").unwrap(),
            protocol_min: 1,
            protocol_max: 1,
        }
    }

    #[test]
    fn activation_order_has_no_active_before_local_stable() {
        let mut transaction = ActivationTransaction {
            id: "tx-1".into(),
            nonce: "n".repeat(32),
            kind: TransactionKind::Update,
            phase: ActivationPhase::CandidateStaged,
            source_sha256: "a".repeat(64),
            target_sha256: "b".repeat(64),
            run_set_digest: None,
            hub_receipt_ids: BTreeMap::new(),
            attempt: 1,
            source_hub_epoch: None,
        };
        assert!(
            transaction
                .advance(ActivationPhase::PreflightPassed)
                .is_ok()
        );
        assert!(transaction.advance(ActivationPhase::HubActive).is_err());
    }

    #[test]
    fn journal_round_trip_detects_tampering() {
        let root =
            std::env::temp_dir().join(format!("xmatrix-continuity-{}", uuid::Uuid::new_v4()));
        let path = root.join("activation.json");
        let payload = JournalPayload {
            ..test_journal_payload(artifact("stable", 'a'))
        };
        let journal = ActivationJournal::new(&path);
        journal.store(&payload).unwrap();
        assert_eq!(journal.load().unwrap(), payload);
        let mut bytes = fs::read(&path).unwrap();
        let index = bytes.iter().position(|value| *value == b'a').unwrap();
        bytes[index] = b'b';
        fs::write(&path, bytes).unwrap();
        assert!(journal.load().is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn activation_journal_recovers_the_last_valid_previous_image() {
        let root = std::env::temp_dir().join(format!(
            "xmatrix-continuity-previous-{}",
            uuid::Uuid::new_v4()
        ));
        let path = root.join("activation.json");
        let journal = ActivationJournal::new(&path);
        let mut payload = JournalPayload {
            last_hub_epoch: Some(7),
            ..test_journal_payload(artifact("stable", 'a'))
        };
        journal.store(&payload).unwrap();
        payload.revision = 2;
        payload.last_hub_epoch = Some(8);
        journal.store(&payload).unwrap();
        fs::write(&path, b"power-loss").unwrap();
        let recovered = journal.load().unwrap();
        assert_eq!(recovered.revision, 1);
        assert_eq!(recovered.last_hub_epoch, Some(7));
        assert!(previous_image_path(&path).is_file());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn run_accounting_requires_exact_complete_set() {
        let mut accounting = RunAccounting {
            expected: BTreeSet::from(["run-1".into()]),
            adopted: BTreeMap::new(),
            natural_terminal: BTreeSet::new(),
            quarantined: BTreeSet::new(),
        };
        assert!(matches!(
            accounting.validate_complete(),
            Err(ContinuityError::RunSetIncomplete)
        ));
        accounting.natural_terminal.insert("run-1".into());
        assert!(accounting.validate_complete().is_ok());
    }

    #[test]
    fn frames_are_bounded_and_typed() {
        let message = ControlMessage::Hello {
            protocol_major: 1,
            nonce: "n".repeat(32),
        };
        let frame = encode_frame(&message).unwrap();
        assert_eq!(decode_frame(&mut frame.as_slice()).unwrap(), message);
        let oversized = (MAX_CONTROL_FRAME_BYTES as u32 + 1).to_be_bytes();
        assert!(matches!(
            decode_frame(&mut oversized.as_slice()),
            Err(ContinuityError::FrameTooLarge(_))
        ));
    }

    #[test]
    fn effect_journal_replays_committed_result_without_reexecuting() {
        let root =
            std::env::temp_dir().join(format!("xmatrix-effect-journal-{}", uuid::Uuid::new_v4()));
        let journal = CommandEffectJournal::new(root.join("effects.json"));
        let received = journal
            .receive("control-1", "spawn", &"a".repeat(64))
            .unwrap();
        let stable_id = received.stable_id();
        journal.admit(&stable_id).unwrap();
        let committed = journal
            .commit_result(&stable_id, serde_json::json!({"ok": true, "pid": 7}))
            .unwrap();
        assert_eq!(committed.phase, EffectPhase::EffectCommitted);
        assert!(committed.received_monotonic_ms.is_some());
        assert!(committed.admitted_monotonic_ms >= committed.received_monotonic_ms);
        assert!(committed.effect_committed_monotonic_ms >= committed.admitted_monotonic_ms);
        assert_eq!(
            journal
                .receive("control-1", "spawn", &"a".repeat(64))
                .unwrap()
                .result,
            Some(serde_json::json!({"ok": true, "pid": 7}))
        );
        assert_eq!(
            journal.pending_completion_results().unwrap(),
            vec![serde_json::json!({"ok": true, "pid": 7})]
        );
        assert!(
            journal
                .receive("control-1", "stop", &"b".repeat(64))
                .is_err()
        );
        assert_eq!(
            journal.acknowledge("control-1").unwrap().phase,
            EffectPhase::HubCompletionAcked
        );
        assert!(journal.pending_completion_results().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn effect_journal_persists_a_fenced_replay_envelope_before_network_retry() {
        let root = std::env::temp_dir().join(format!(
            "xmatrix-effect-journal-rebind-{}",
            uuid::Uuid::new_v4()
        ));
        let journal = CommandEffectJournal::new(root.join("effects.json"));
        let effect = journal
            .receive("control-1", "spawn", &"a".repeat(64))
            .unwrap();
        let stable_id = effect.stable_id();
        journal.admit(&stable_id).unwrap();
        let committed = journal
            .commit_result(
                &stable_id,
                serde_json::json!({"ok": false, "relayLease": {"daemonEpoch": 1}}),
            )
            .unwrap();
        let rebound = serde_json::json!({
            "ok": false, "relayLease": {"daemonEpoch": 2}
        });
        journal
            .rebind_committed_result(
                &stable_id,
                committed.result_digest.as_deref().unwrap(),
                rebound.clone(),
            )
            .unwrap();
        assert_eq!(journal.pending_completion_results().unwrap(), vec![rebound]);
        assert!(
            journal
                .rebind_committed_result(
                    &stable_id,
                    &"b".repeat(64),
                    serde_json::json!({"ok": true})
                )
                .is_err()
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn boot_journal_selects_only_valid_non_quarantined_artifact() {
        let committed = artifact("supervisor-stable", 'a');
        let pending = artifact("supervisor-next", 'b');
        let mut payload = BootPayload {
            schema: JOURNAL_SCHEMA,
            revision: 1,
            phase: BootPhase::Pending,
            committed,
            previous: None,
            pending: Some(pending.clone()),
            quarantined_sha256: BTreeSet::new(),
        };
        assert_eq!(payload.selected().unwrap(), &pending);
        payload.quarantined_sha256.insert(pending.sha256.clone());
        assert!(payload.selected().is_err());
    }

    #[test]
    fn replay_guard_rejects_duplicate_and_out_of_order_frames() {
        let nonce = "n".repeat(32);
        let mut guard = ReplayGuard::new(nonce.clone()).unwrap();
        let frame = AuthenticatedControlFrame {
            protocol_major: 1,
            sequence: 1,
            nonce,
            message: ControlMessage::FailClosed {
                transaction_id: None,
                reason: "test".into(),
            },
        };
        guard.validate(&frame).unwrap();
        assert!(matches!(
            guard.validate(&frame),
            Err(ContinuityError::ReplayRejected)
        ));
    }

    #[test]
    fn signed_release_envelope_binds_exact_artifact_and_rollback_floor() {
        let artifact = artifact("daemon-next", 'b');
        let payload = ReleaseEnvelopePayload {
            workflow: "cli-release.yml".into(),
            run_id: 42,
            run_attempt: 1,
            git_sha: "c".repeat(40),
            provenance: "github-actions:LambdaLabsHQ/xmatrix".into(),
            release_sequence: artifact.release_sequence,
            target: artifact.target.clone(),
            size: 123,
            sha256: artifact.sha256.clone(),
            publisher: artifact.publisher_sha256.clone(),
            protocol_min: artifact.protocol_min,
            protocol_max: artifact.protocol_max,
            rollback_floor: artifact.release_sequence,
            expires_at_unix: 2_000,
        };
        validate_release_envelope_payload(&payload, &artifact, 123, 1_999, 127, false).unwrap();
        assert!(
            validate_release_envelope_payload(&payload, &artifact, 124, 1_999, 127, false).is_err()
        );
        assert!(
            validate_release_envelope_payload(&payload, &artifact, 123, 2_001, 127, false).is_err()
        );
        validate_release_envelope_payload(
            &payload,
            &artifact,
            123,
            2_001,
            artifact.release_sequence,
            true,
        )
        .unwrap();
        assert!(
            validate_release_envelope_payload(
                &payload,
                &artifact,
                123,
                1_999,
                artifact.release_sequence + 1,
                true,
            )
            .is_err()
        );

        let root =
            std::env::temp_dir().join(format!("xmatrix-release-envelope-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("release-envelope.exe");
        let envelope = EmbeddedReleaseEnvelope { schema: 1, payload };
        let mut bytes = b"signed-pe-template".to_vec();
        bytes.extend_from_slice(&encode_release_envelope_trailer(&envelope).unwrap());
        fs::write(&path, bytes).unwrap();
        assert_eq!(read_embedded_release_envelope(&path).unwrap(), envelope);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn release_sequence_is_monotonic_across_minor_and_major_trains() {
        assert!(
            release_sequence_from_version("0.17.0").unwrap()
                > release_sequence_from_version("0.16.999999").unwrap()
        );
        assert!(
            release_sequence_from_version("1.0.0").unwrap()
                > release_sequence_from_version("0.999999.999999").unwrap()
        );
    }

    #[test]
    fn thousand_handoff_rollback_and_crash_transactions_remain_bounded() {
        let committed = artifact("daemon-soak-0", 'a');
        let mut kernel = ActivationKernel::new(JournalPayload {
            generation_pins: BTreeSet::from([committed.generation.clone()]),
            last_hub_epoch: Some(1),
            ..test_journal_payload(committed)
        })
        .unwrap();
        for iteration in 1..=1_000u64 {
            let nonce = format!("{iteration:032x}");
            if iteration % 5 == 0 {
                kernel
                    .apply(KernelEvent::BeginCrashRecovery {
                        transaction_id: format!("crash-{iteration}"),
                        nonce,
                        source_hub_epoch: iteration,
                    })
                    .unwrap();
            } else {
                let mut candidate = artifact("daemon-soak-candidate", 'b');
                candidate.generation = format!("daemon-soak-{iteration}");
                candidate.sha256 = hex_sha256(candidate.generation.as_bytes());
                candidate.release_envelope_sha256 =
                    hex_sha256(format!("envelope-{iteration}").as_bytes());
                candidate.release_sequence = 1_000_000_000 + iteration;
                kernel
                    .apply(KernelEvent::StageCandidate {
                        transaction_id: format!("update-{iteration}"),
                        nonce: nonce.clone(),
                        kind: TransactionKind::Update,
                        source_hub_epoch: Some(iteration),
                        artifact: candidate.clone(),
                    })
                    .unwrap();
                kernel.apply(KernelEvent::PreflightPassed).unwrap();
                kernel.apply(KernelEvent::BeginDrain).unwrap();
                kernel
                    .apply(KernelEvent::DrainReady {
                        run_set_digest: hex_sha256(format!("runs-{iteration}").as_bytes()),
                        generation_pins: BTreeSet::from([
                            kernel.payload().committed.generation.clone(),
                            candidate.generation,
                        ]),
                    })
                    .unwrap();
                kernel.apply(KernelEvent::OldExited).unwrap();
                kernel.apply(KernelEvent::BeginRecovery).unwrap();
            }
            kernel
                .apply(KernelEvent::ActivationPrepared {
                    receipt_id: format!("prepared-{iteration}"),
                    run_set_digest: hex_sha256(format!("adopted-{iteration}").as_bytes()),
                })
                .unwrap();
            kernel.apply(KernelEvent::LocalCommit).unwrap();

            if iteration % 7 == 0 && iteration % 5 != 0 {
                let rollback = kernel.payload().previous.clone().unwrap();
                kernel
                    .apply(KernelEvent::BeginRollback {
                        transaction_id: format!("rollback-{iteration}"),
                        nonce: format!("r{iteration:031x}"),
                        source_hub_epoch: iteration + 1,
                        artifact: rollback,
                    })
                    .unwrap();
                kernel
                    .apply(KernelEvent::ActivationPrepared {
                        receipt_id: format!("rollback-prepared-{iteration}"),
                        run_set_digest: hex_sha256(
                            format!("rollback-adopted-{iteration}").as_bytes(),
                        ),
                    })
                    .unwrap();
                kernel.apply(KernelEvent::LocalCommit).unwrap();
            }

            for event in [
                KernelEvent::ActiveFenced {
                    receipt_id: format!("fenced-{iteration}"),
                },
                KernelEvent::BeginProbation,
                KernelEvent::HubActive {
                    receipt_id: format!("active-{iteration}"),
                },
                KernelEvent::PersistStable,
                KernelEvent::StableGranted,
            ] {
                kernel.apply(event).unwrap();
            }
            kernel
                .apply(KernelEvent::CompleteStable {
                    hub_epoch: iteration + 1,
                })
                .unwrap();
            assert!(kernel.admission_open());
            assert!(kernel.payload().transaction.is_none());
            assert!(kernel.payload().generation_pins.len() <= 2);
            assert!(kernel.payload().quarantined_sha256.len() <= MAX_QUARANTINED_ARTIFACTS);
            assert!(serde_json::to_vec(kernel.payload()).unwrap().len() < MAX_CONTROL_FRAME_BYTES);
        }
    }

    #[test]
    fn structured_continuity_events_are_checksummed_and_bounded() {
        let root = std::env::temp_dir().join(format!(
            "xmatrix-continuity-events-{}",
            uuid::Uuid::new_v4()
        ));
        let log = ContinuityEventLog::new(root.join("events.json"));
        for iteration in 0..(MAX_CONTINUITY_EVENTS + 7) {
            log.append(
                "supervisor",
                "activation_transition",
                Some(&format!("tx-{iteration}")),
                Some(&hex_sha256(iteration.to_string().as_bytes())),
                Some("recovering"),
                None,
            )
            .unwrap();
        }
        let events = log.read().unwrap();
        assert_eq!(events.len(), MAX_CONTINUITY_EVENTS);
        assert_eq!(events.first().unwrap().sequence, 8);
        let mut bytes = fs::read(root.join("events.json")).unwrap();
        let index = bytes.iter().position(|byte| *byte == b's').unwrap();
        bytes[index] = b'x';
        fs::write(root.join("events.json"), bytes).unwrap();
        assert!(log.read().is_err());
        fs::remove_dir_all(root).unwrap();
    }

    fn stage_test_update(kernel: &mut ActivationKernel, candidate: &ArtifactIdentity) {
        kernel
            .apply(KernelEvent::StageCandidate {
                transaction_id: "tx-1".into(),
                nonce: "n".repeat(32),
                kind: TransactionKind::Update,
                source_hub_epoch: Some(7),
                artifact: candidate.clone(),
            })
            .unwrap();
    }

    fn commit_test_update(
        kernel: &mut ActivationKernel,
        prepared_receipt: &str,
        prepared_digest: &str,
    ) {
        for event in [
            KernelEvent::PreflightPassed,
            KernelEvent::BeginDrain,
            KernelEvent::DrainReady {
                run_set_digest: "c".repeat(64),
                generation_pins: BTreeSet::new(),
            },
            KernelEvent::OldExited,
            KernelEvent::BeginRecovery,
            KernelEvent::ActivationPrepared {
                receipt_id: prepared_receipt.into(),
                run_set_digest: prepared_digest.into(),
            },
            KernelEvent::LocalCommit,
        ] {
            kernel.apply(event).unwrap();
        }
    }

    #[test]
    fn activation_kernel_opens_admission_only_after_stable_granted() {
        let committed = artifact("daemon-stable", 'a');
        let candidate = artifact("daemon-next", 'b');
        let mut kernel = ActivationKernel::new(JournalPayload {
            generation_pins: BTreeSet::from([committed.generation.clone()]),
            ..test_journal_payload(committed)
        })
        .unwrap();
        stage_test_update(&mut kernel, &candidate);
        assert!(!kernel.admission_open());
        commit_test_update(&mut kernel, "prepared-1", &"d".repeat(64));
        for event in [
            KernelEvent::ActiveFenced {
                receipt_id: "fenced-1".into(),
            },
            KernelEvent::BeginProbation,
            KernelEvent::HubActive {
                receipt_id: "active-1".into(),
            },
            KernelEvent::PersistStable,
            KernelEvent::StableGranted,
        ] {
            kernel.apply(event).unwrap();
        }
        assert!(kernel.admission_open());
        assert_eq!(kernel.payload().committed, candidate);
        assert!(kernel.apply(KernelEvent::AbortBeforeCommit).is_err());
    }

    #[test]
    fn failed_candidate_rolls_back_only_to_exact_previous_lkg() {
        let committed = artifact("daemon-stable", 'a');
        let candidate = artifact("daemon-next", 'b');
        let mut kernel = ActivationKernel::new(JournalPayload {
            last_hub_epoch: Some(7),
            ..test_journal_payload(committed.clone())
        })
        .unwrap();
        stage_test_update(&mut kernel, &candidate);
        commit_test_update(&mut kernel, "prepared", &"c".repeat(64));
        assert_eq!(kernel.payload().committed.sha256, candidate.sha256);
        kernel
            .apply(KernelEvent::BeginRollback {
                transaction_id: "rollback-1".into(),
                nonce: "r".repeat(32),
                source_hub_epoch: 7,
                artifact: committed.clone(),
            })
            .unwrap();
        assert_eq!(
            kernel.payload().candidate.as_ref().unwrap().sha256,
            committed.sha256
        );
        assert!(
            kernel
                .payload()
                .quarantined_sha256
                .contains(&candidate.sha256)
        );
        assert_eq!(
            kernel.payload().transaction.as_ref().unwrap().kind,
            TransactionKind::Rollback
        );
    }
}
