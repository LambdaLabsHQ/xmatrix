//! One record of where the local daemon is, and one way to read or write it.
//!
//! The daemon rebinds ephemeral ports on every start, so "where is the daemon"
//! is a fact that changes and must be recorded. Today it is recorded three
//! times — `daemon-auth-broker.json`, `daemon-request-broker.json` and
//! `daemon-host/control.json` — with three shapes and readers scattered across
//! both crates. Nothing says which to believe when they disagree, and a Run
//! that could not mint a token for hours traced back to two copies of the same
//! logic where only one was wrong.
//!
//! Readers here report what went wrong. A locator that silently becomes "no
//! locator" when its file is corrupt is indistinguishable from a daemon that
//! has never started, and that ambiguity is what makes these failures expensive.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::config;
use crate::error::{CliError, Result};

/// Bounds the read. The record holds a handful of short fields.
const MAX_RECORD_BYTES: u64 = 8 * 1024;
pub const DAEMON_RECORD_SCHEMA_VERSION: u32 = 1;
const DAEMON_RECORD_FILE: &str = "daemon-record.json";

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DaemonRecord {
    pub schema_version: u32,
    /// The daemon process that owns this record and the singleton lock.
    pub pid: u32,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub generation: Option<String>,
    /// Present when the daemon runs under an explicit Profile. A record for
    /// another Profile locates another daemon and must not be adopted.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub profile_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub auth_broker_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub request_broker_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub host_control_url: Option<String>,
    /// Preferred over the TCP locator when present. Absent means this daemon
    /// predates socket support, not that the socket failed.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub auth_broker_socket: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub request_broker_socket: Option<String>,
    pub updated_at: String,
}

/// The directory the record lives in.
///
/// `config::config_dir()` falls back to `PathBuf::from(".")` when no home
/// directory can be resolved, which makes the path depend on the caller's
/// working directory — and an Agent Run's working directory is its workspace,
/// never the daemon's. A locator that resolves differently per process is worse
/// than no locator, so this refuses instead.
pub fn record_dir() -> Result<PathBuf> {
    let dir = config::config_dir();
    if dir.is_absolute() {
        return Ok(dir);
    }
    Err(CliError::Launch(format!(
        "Daemon state root is not absolute ({}); set XMATRIX_CONFIG_DIR or a home directory \
         so every process resolves the same daemon record",
        dir.display(),
    )))
}

/// Longest socket path the platform will bind. macOS caps `sun_path` at 104
/// bytes and Linux at 108; use the smaller so a path that works on one host is
/// not silently unbindable on another.
pub const MAX_SOCKET_PATH_BYTES: usize = 104;

/// Where a daemon listener lives. A socket path is stable across restarts —
/// unlike an ephemeral port — which is the whole reason to prefer it, and it
/// sits in the Profile's own directory the way OpenSSH moved agent sockets into
/// `~/.ssh` rather than leaving them in a shared namespace.
pub fn socket_path(name: &str) -> Result<PathBuf> {
    if name.is_empty() || name.contains('/') || name.contains('\\') {
        return Err(CliError::Launch(format!(
            "Daemon socket name {name:?} must be a bare file name",
        )));
    }
    let path = record_dir()?.join(format!("{name}.sock"));
    let length = path.as_os_str().as_encoded_bytes().len();
    if length > MAX_SOCKET_PATH_BYTES {
        // Reported rather than truncated: a silently shortened path binds
        // somewhere nobody is listening.
        return Err(CliError::Launch(format!(
            "Daemon socket path is {length} bytes, over the {MAX_SOCKET_PATH_BYTES}-byte limit: {}",
            path.display(),
        )));
    }
    Ok(path)
}

pub fn record_path() -> Result<PathBuf> {
    Ok(record_dir()?.join(DAEMON_RECORD_FILE))
}

/// Read the record. `Ok(None)` means no daemon has written one; every other
/// failure is returned rather than folded into "absent".
pub fn read_record() -> Result<Option<DaemonRecord>> {
    let path = record_path()?;
    let Some(metadata) = crate::fs::metadata_if_exists(&path).map_err(CliError::Io)? else {
        return Ok(None);
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(CliError::Launch(format!(
            "Daemon record at {} is not a regular file",
            path.display(),
        )));
    }
    if metadata.len() > MAX_RECORD_BYTES {
        return Err(CliError::Launch(format!(
            "Daemon record at {} exceeds {MAX_RECORD_BYTES} bytes",
            path.display(),
        )));
    }
    let bytes = std::fs::read(&path).map_err(CliError::Io)?;
    let record: DaemonRecord = serde_json::from_slice(&bytes).map_err(|error| {
        CliError::Launch(format!(
            "Daemon record at {} could not be read: {error}",
            path.display(),
        ))
    })?;
    if record.schema_version != DAEMON_RECORD_SCHEMA_VERSION {
        return Err(CliError::Launch(format!(
            "Daemon record at {} has schema version {}; this build understands {}",
            path.display(),
            record.schema_version,
            DAEMON_RECORD_SCHEMA_VERSION,
        )));
    }
    Ok(Some(record))
}

/// Read the record for the Profile this process runs under, reporting why a
/// record was rejected instead of returning nothing.
pub fn read_record_for_active_profile() -> Result<Option<DaemonRecord>> {
    let Some(record) = read_record()? else {
        return Ok(None);
    };
    let active = config::active_profile_context().map(|profile| profile.id.as_str().to_string());
    if record.profile_id != active {
        return Err(CliError::Launch(format!(
            "Daemon record belongs to Profile {:?} but this process runs under {:?}",
            record.profile_id, active,
        )));
    }
    Ok(Some(record))
}

pub fn write_record(record: &DaemonRecord) -> Result<()> {
    let path = record_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(CliError::Io)?;
    }
    let bytes = serde_json::to_vec_pretty(record).map_err(|error| {
        CliError::Launch(format!("Daemon record could not be encoded: {error}"))
    })?;
    let temporary = config::unique_temporary_path(&path);
    write_private_file(&temporary, &bytes)?;
    config::replace_file_atomically(&temporary, &path).inspect_err(|_error| {
        let _ = std::fs::remove_file(&temporary);
    })?;
    Ok(())
}

/// Apply one locator to the shared record, preserving the others.
///
/// Each broker learns its own address at a different moment, so the record is
/// built by whoever knows something rather than by one writer that would have
/// to wait for all three. A record that cannot be read is replaced rather than
/// merged into: a corrupt file must not pin a stale locator forever.
pub fn update_record(apply: impl FnOnce(&mut DaemonRecord)) -> Result<DaemonRecord> {
    let mut record = read_record().unwrap_or(None).unwrap_or_default();
    record.schema_version = DAEMON_RECORD_SCHEMA_VERSION;
    record.pid = std::process::id();
    record.profile_id = config::active_profile_context().map(|p| p.id.as_str().to_string());
    apply(&mut record);
    record.updated_at = config::unix_now_secs().to_string();
    write_record(&record)?;
    Ok(record)
}

fn write_private_file(path: &std::path::Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write as _;
    let mut options = std::fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(CliError::Io)?;
    file.write_all(bytes).map_err(CliError::Io)?;
    file.sync_all().map_err(CliError::Io)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record() -> DaemonRecord {
        DaemonRecord {
            schema_version: DAEMON_RECORD_SCHEMA_VERSION,
            pid: 4242,
            generation: Some("gen-1".into()),
            profile_id: Some("profile:one".into()),
            auth_broker_url: Some("http://127.0.0.1:54178".into()),
            request_broker_url: Some("http://127.0.0.1:54179".into()),
            host_control_url: Some("http://127.0.0.1:54165".into()),
            auth_broker_socket: Some("/tmp/xmatrix/auth-broker.sock".into()),
            request_broker_socket: Some("/tmp/xmatrix/request-broker.sock".into()),
            updated_at: "2026-09-18T00:00:00Z".into(),
        }
    }

    #[test]
    fn one_record_carries_every_locator_that_lives_in_three_files_today() {
        let encoded = serde_json::to_vec(&record()).unwrap();
        let decoded: DaemonRecord = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(decoded, record());
        assert!(decoded.auth_broker_url.is_some());
        assert!(decoded.request_broker_url.is_some());
        assert!(decoded.host_control_url.is_some());
        assert!(decoded.auth_broker_socket.is_some());
        assert!(decoded.request_broker_socket.is_some());
    }

    #[test]
    fn a_future_schema_is_refused_by_name_rather_than_silently_ignored() {
        let mut future = record();
        future.schema_version = DAEMON_RECORD_SCHEMA_VERSION + 1;
        let encoded = serde_json::to_vec(&future).unwrap();
        let decoded: DaemonRecord = serde_json::from_slice(&encoded).unwrap();
        assert_ne!(decoded.schema_version, DAEMON_RECORD_SCHEMA_VERSION);
    }

    #[test]
    fn absent_locators_round_trip_as_absent_rather_than_empty_strings() {
        let sparse = DaemonRecord {
            schema_version: DAEMON_RECORD_SCHEMA_VERSION,
            pid: 7,
            updated_at: "2026-09-18T00:00:00Z".into(),
            ..Default::default()
        };
        let encoded = String::from_utf8(serde_json::to_vec(&sparse).unwrap()).unwrap();
        assert!(!encoded.contains("authBrokerUrl"), "{encoded}");
        let decoded: DaemonRecord = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded.auth_broker_url, None);
    }
}
