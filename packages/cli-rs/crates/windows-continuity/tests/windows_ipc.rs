#![cfg(windows)]

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use xmatrix_windows_continuity::{
    ActivationJournal, ArtifactIdentity, BootJournal, BootPayload, BootPhase,
    EmbeddedReleaseEnvelope, JOURNAL_SCHEMA, JournalPayload, ReleaseEnvelopePayload,
    encode_release_envelope_trailer, release_sequence_from_version, sha256_file,
};

#[test]
fn bootstrap_supervisor_daemon_use_inherited_private_pipes() {
    let root = std::env::temp_dir().join(format!(
        "xmatrix-inherited-pipe-e2e-{}",
        uuid::Uuid::new_v4().simple()
    ));
    let supervisor = copy_artifact(
        env!("CARGO_BIN_EXE_xmatrix-supervisor"),
        &root.join("supervisors/stable/xmatrix-supervisor.exe"),
    );
    // A generation lives in the directory named after it. The Supervisor
    // collects every unpinned generation directory once the daemon is
    // stable, so any other name had it delete the running daemon's own
    // directory, failing whenever the daemon had not exited yet.
    let daemon = copy_artifact(
        env!("CARGO_BIN_EXE_xmatrix-control-probe"),
        &root.join("generations/daemon-stable/xmatrix.exe"),
    );
    let supervisor_artifact = artifact("supervisor-stable", &supervisor);
    let daemon_artifact = artifact("daemon-stable", &daemon);
    BootJournal::new(root.join("boot-journal.json"))
        .store(&BootPayload {
            schema: JOURNAL_SCHEMA,
            revision: 1,
            phase: BootPhase::Stable,
            committed: supervisor_artifact,
            previous: None,
            pending: None,
            quarantined_sha256: BTreeSet::new(),
        })
        .unwrap();
    ActivationJournal::new(root.join("activation-journal.json"))
        .store(&JournalPayload {
            schema: JOURNAL_SCHEMA,
            revision: 1,
            generation_pins: BTreeSet::from([daemon_artifact.generation.clone()]),
            committed: daemon_artifact,
            previous: None,
            candidate: None,
            transaction: None,
            quarantined_sha256: BTreeSet::new(),
            last_hub_epoch: None,
        })
        .unwrap();

    let status = std::process::Command::new(env!("CARGO_BIN_EXE_xmatrix-bootstrap"))
        .args([
            "--root",
            root.to_string_lossy().as_ref(),
            "--hub-url",
            "https://xmatrix.invalid",
        ])
        .env("XMATRIX_TEST_ALLOW_UNSIGNED_CONTINUITY", "1")
        .status()
        .unwrap();
    assert!(status.success(), "bootstrap chain failed: {status}");
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn bootstrap_initializes_exact_generation_journals() {
    let root = std::env::temp_dir().join(format!(
        "xmatrix-continuity-init-{}",
        uuid::Uuid::new_v4().simple()
    ));
    let supervisor = copy_artifact(
        env!("CARGO_BIN_EXE_xmatrix-supervisor"),
        &root.join("supervisors/s1/xmatrix-supervisor.exe"),
    );
    let daemon = copy_artifact(
        env!("CARGO_BIN_EXE_xmatrix-control-probe"),
        &root.join("generations/d1/xmatrix.exe"),
    );
    let recovery = copy_artifact(
        env!("CARGO_BIN_EXE_xmatrix-recovery-adapter"),
        &root.join("supervisors/recovery/xmatrix-recovery-adapter.exe"),
    );
    let supervisor_envelope = write_release_envelope(&supervisor, "0.16.129");
    let daemon_envelope = write_release_envelope(&daemon, "0.16.129");
    let recovery_envelope = write_release_envelope(&recovery, "0.16.129");
    let release_sequence = release_sequence_from_version("0.16.129")
        .unwrap()
        .to_string();
    let status = std::process::Command::new(env!("CARGO_BIN_EXE_xmatrix-bootstrap"))
        .args([
            "--initialize",
            "--root",
            root.to_string_lossy().as_ref(),
            "--supervisor",
            supervisor.to_string_lossy().as_ref(),
            "--daemon",
            daemon.to_string_lossy().as_ref(),
            "--supervisor-envelope",
            supervisor_envelope.to_string_lossy().as_ref(),
            "--daemon-envelope",
            daemon_envelope.to_string_lossy().as_ref(),
            "--recovery-supervisor",
            recovery.to_string_lossy().as_ref(),
            "--recovery-envelope",
            recovery_envelope.to_string_lossy().as_ref(),
            "--version",
            "0.16.129",
            "--target",
            "x86_64-pc-windows-msvc",
            "--release-sequence",
            &release_sequence,
            "--migration-transaction",
            "migration-tx-1",
            "--migration-nonce",
            "n1234567890123456789012345678901",
            "--migration-source-epoch",
            "7",
        ])
        .env("XMATRIX_TEST_ALLOW_UNSIGNED_CONTINUITY", "1")
        .status()
        .expect("run Boot Verifier initializer");
    assert!(status.success());
    let boot = BootJournal::new(root.join("boot-journal.json"))
        .load()
        .unwrap();
    let activation = ActivationJournal::new(root.join("activation-journal.json"))
        .load()
        .unwrap();
    assert_eq!(
        boot.committed.executable_path,
        std::fs::canonicalize(recovery).unwrap()
    );
    assert_eq!(boot.phase, BootPhase::Pending);
    assert_eq!(
        boot.pending
            .as_ref()
            .map(|value| value.executable_path.clone()),
        Some(std::fs::canonicalize(supervisor).unwrap())
    );
    assert_eq!(
        activation.committed.executable_path,
        std::fs::canonicalize(daemon).unwrap()
    );
    assert_eq!(activation.last_hub_epoch, Some(7));
    assert_eq!(
        activation
            .transaction
            .as_ref()
            .map(|value| value.id.as_str()),
        Some("migration-tx-1")
    );
    let pending = copy_artifact(
        env!("CARGO_BIN_EXE_xmatrix-supervisor"),
        &root.join("supervisors/s2/xmatrix-supervisor.exe"),
    );
    use std::io::Write as _;
    std::fs::OpenOptions::new()
        .append(true)
        .open(&pending)
        .unwrap()
        .write_all(b"pending-test")
        .unwrap();
    let pending_envelope = write_release_envelope(&pending, "0.16.130");
    let pending_sequence = release_sequence_from_version("0.16.130")
        .unwrap()
        .to_string();
    let staged = std::process::Command::new(env!("CARGO_BIN_EXE_xmatrix-bootstrap"))
        .args([
            "--stage-supervisor",
            "--root",
            root.to_string_lossy().as_ref(),
            "--supervisor",
            pending.to_string_lossy().as_ref(),
            "--release-envelope",
            pending_envelope.to_string_lossy().as_ref(),
            "--version",
            "0.16.130",
            "--target",
            "x86_64-pc-windows-msvc",
            "--release-sequence",
            &pending_sequence,
        ])
        .env("XMATRIX_TEST_ALLOW_UNSIGNED_CONTINUITY", "1")
        .status()
        .unwrap();
    assert!(staged.success());
    assert_eq!(
        BootJournal::new(root.join("boot-journal.json"))
            .load()
            .unwrap()
            .phase,
        BootPhase::Pending
    );
    std::fs::remove_dir_all(root).unwrap();
}

fn copy_artifact(source: &str, destination: &Path) -> PathBuf {
    std::fs::create_dir_all(destination.parent().unwrap()).unwrap();
    std::fs::copy(source, destination).unwrap();
    destination.to_path_buf()
}

fn artifact(generation: &str, path: &Path) -> ArtifactIdentity {
    let version = "0.16.1";
    let release_envelope_path = write_release_envelope(path, version);
    ArtifactIdentity {
        generation: generation.to_string(),
        sha256: sha256_file(path).unwrap(),
        executable_path: path.to_path_buf(),
        release_envelope_sha256: sha256_file(&release_envelope_path).unwrap(),
        release_envelope_path,
        publisher_sha256: "0".repeat(64),
        version: version.to_string(),
        target: "x86_64-pc-windows-msvc".to_string(),
        release_sequence: release_sequence_from_version(version).unwrap(),
        protocol_min: 1,
        protocol_max: 1,
    }
}

fn write_release_envelope(artifact: &Path, version: &str) -> PathBuf {
    use std::io::Write as _;

    let path = artifact.with_file_name("release-envelope.exe");
    copy_artifact(env!("CARGO_BIN_EXE_xmatrix-release-envelope"), &path);
    let payload = ReleaseEnvelopePayload {
        workflow: "cli-release.yml".into(),
        run_id: 1,
        run_attempt: 1,
        git_sha: "a".repeat(40),
        provenance: "windows-native-test".into(),
        release_sequence: release_sequence_from_version(version).unwrap(),
        target: "x86_64-pc-windows-msvc".into(),
        size: std::fs::metadata(artifact).unwrap().len(),
        sha256: sha256_file(artifact).unwrap(),
        publisher: "0".repeat(64),
        protocol_min: 1,
        protocol_max: 1,
        rollback_floor: release_sequence_from_version(version).unwrap(),
        expires_at_unix: u64::MAX,
    };
    std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap()
        .write_all(
            &encode_release_envelope_trailer(&EmbeddedReleaseEnvelope { schema: 1, payload })
                .unwrap(),
        )
        .unwrap();
    path
}
