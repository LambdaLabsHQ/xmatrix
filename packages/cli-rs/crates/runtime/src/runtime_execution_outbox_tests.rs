use super::*;
pub(super) struct Fixture(PathBuf);
impl Fixture {
    pub(super) fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("xmatrix-execution-outbox-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        Self(root)
    }
    pub(super) fn outbox(&self) -> ExecutionOutbox {
        ExecutionOutbox::for_test(self.0.join("outbox"))
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
pub(super) fn report() -> AgentRuntimeExecutionEvidence {
    AgentRuntimeExecutionEvidence {
        execution_id: uuid::Uuid::new_v4().to_string(),
        revision: 1,
        source_count: 1,
        sources: vec![xmatrix_cli_core::protocol::AgentRuntimeMessageSource {
            channel_id: "channel".into(),
            message_id: "message".into(),
            sequence: 1,
            entity_version: 1,
            body_hash: "a".repeat(64),
        }],
        state: "accepted".into(),
        input_disposition: Some("pending".into()),
        started_at_millis: 100,
        updated_at_millis: 100,
        finished_at_millis: None,
    }
}
#[test]
fn rapid_executions_survive_the_eight_entry_snapshot_and_reopen() {
    let fixture = Fixture::new();
    let outbox = fixture.outbox();
    let marker = fixture.0.join("run.status.json");
    crate::write_daemon_run_status_marker_to_path(&marker, "runtime_ready", false, None);
    let mut tracker = crate::AgentRuntimeStateTracker::new("test");
    tracker.marker_path = Some(marker.clone());
    tracker.execution_outbox = Some(outbox.clone());
    let mut ids = Vec::new();
    for n in 0..40 {
        let mut source = report().sources.remove(0);
        source.message_id = format!("message-{n}");
        let message_id = source.message_id.clone();
        let mut turn =
            tracker.begin_message_turn(Some("channel"), Some(&message_id), 1, vec![source]);
        ids.push(turn.execution_id.clone());
        turn.finish_as(if n % 2 == 0 { "completed" } else { "failed" });
    }
    assert_eq!(tracker.snapshot().recent_executions.len(), 8);
    drop(tracker);
    for (n, id) in ids.iter().enumerate() {
        let stored = read(&fixture.outbox().path(id).unwrap()).unwrap();
        assert_eq!(
            stored.report.state,
            if n % 2 == 0 { "completed" } else { "failed" }
        );
        assert_eq!(stored.report.sources[0].message_id, format!("message-{n}"));
    }
    let mut foreign = crate::read_daemon_run_status_marker(Some(&marker)).unwrap();
    foreign.pid += 1;
    fs::write(&marker, serde_json::to_vec(&foreign).unwrap()).unwrap();
    let mut tracker = crate::AgentRuntimeStateTracker::new("test");
    tracker.marker_path = Some(marker);
    tracker.execution_outbox = Some(outbox.clone());
    let turn = tracker.begin_message_turn(Some("channel"), Some("message"), 1, report().sources);
    assert!(
        !outbox.path(&turn.execution_id).unwrap().exists(),
        "foreign marker PID cannot create reports"
    );
}
fn saved_report_fixture() -> (
    Fixture,
    ExecutionOutbox,
    AgentRuntimeExecutionEvidence,
    PathBuf,
) {
    let fixture = Fixture::new();
    let outbox = fixture.outbox();
    let first = report();
    outbox.save(&first).unwrap();
    let path = outbox.path(&first.execution_id).unwrap();
    (fixture, outbox, first, path)
}

#[test]
fn revisions_and_terminal_results_cannot_be_rebound_or_reopened() {
    let (_fixture, outbox, first, path) = saved_report_fixture();
    let original = fs::read(&path).unwrap();
    outbox.save(&first).unwrap();
    assert_eq!(fs::read(&path).unwrap(), original);
    let mut conflicting = first.clone();
    conflicting.state = "running".into();
    assert!(outbox.save(&conflicting).is_err());
    assert_eq!(fs::read(&path).unwrap(), original);
    let mut final_report = first.clone();
    final_report.revision = 2;
    final_report.state = "completed".into();
    final_report.updated_at_millis = 200;
    final_report.finished_at_millis = Some(200);
    outbox.save(&final_report).unwrap();
    outbox.save(&first).unwrap();
    assert_eq!(read(&path).unwrap().report, final_report);
    let mut reopened = final_report.clone();
    reopened.revision += 1;
    assert!(outbox.save(&reopened).is_err());
    let mut rebound = final_report.clone();
    rebound.sources[0].entity_version = 2;
    assert!(outbox.save(&rebound).is_err());
    assert_eq!(read(&path).unwrap().report, final_report);
}
#[test]
fn count_and_byte_limits_preserve_pending_and_unknown_files() {
    let fixture = Fixture::new();
    let outbox = fixture.outbox();
    let first = report();
    outbox.save(&first).unwrap();
    let original = fs::read(outbox.path(&first.execution_id).unwrap()).unwrap();
    let unknown = outbox.root.join("retained-unknown");
    std::fs::File::create(&unknown)
        .unwrap()
        .set_len(MAX_BYTES)
        .unwrap();
    assert!(outbox.save(&report()).unwrap_err().contains("full"));
    assert_eq!(
        fs::read(outbox.path(&first.execution_id).unwrap()).unwrap(),
        original
    );
    fs::remove_file(&unknown).unwrap();
    for n in 0..MAX_ENTRIES - 2 {
        fs::write(outbox.root.join(format!("unknown-{n}")), b"").unwrap();
    }
    assert!(outbox.save(&report()).unwrap_err().contains("full"));
    assert_eq!(fs::read_dir(&outbox.root).unwrap().count(), MAX_ENTRIES);
}
#[test]
fn independent_writers_serialize_admission_without_losing_reports() {
    let fixture = Fixture::new();
    let outbox = fixture.outbox();
    let reports = (0..8).map(|_| report()).collect::<Vec<_>>();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(reports.len()));
    let threads = reports
        .iter()
        .cloned()
        .map(|report| {
            let outbox = outbox.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                outbox.save(&report)
            })
        })
        .collect::<Vec<_>>();
    for thread in threads {
        thread.join().unwrap().unwrap();
    }
    for report in reports {
        assert_eq!(
            read(&outbox.path(&report.execution_id).unwrap())
                .unwrap()
                .report,
            report
        );
    }
}
/// The host runs many Agents at once against one shared outbox directory. Two
/// Runs can never address the same record, so their writes must not serialize
/// behind each other at all — a machine-wide lock made that contention real.
#[test]
fn writers_for_different_runs_never_share_a_lock() {
    let fixture = Fixture::new();
    let root = fixture.0.join("outbox");
    let runs = (0..8)
        .map(|n| {
            let mut outbox = ExecutionOutbox::for_test(root.clone());
            outbox.scope.run_id = format!("run-{n}");
            outbox.scope.instance_id = format!("instance-{n}");
            outbox
        })
        .collect::<Vec<_>>();
    let report = report();
    let locks = runs
        .iter()
        .map(|outbox| outbox.record_lock(&report.execution_id).unwrap())
        .collect::<std::collections::HashSet<_>>();
    assert_eq!(
        locks.len(),
        runs.len(),
        "each Run must guard its own record"
    );

    // Hold every other Run's record lock, then prove one Run still admits.
    let held = runs[1..]
        .iter()
        .map(|outbox| {
            fs::create_dir_all(&root).unwrap();
            crate::runtime_private_journal::lock(&outbox.record_lock(&report.execution_id).unwrap())
                .unwrap()
        })
        .collect::<Vec<_>>();
    runs[0]
        .save(&report)
        .expect("a Run must not wait on locks held for other Runs");
    drop(held);
    for outbox in &runs[1..] {
        outbox.save(&report).unwrap();
    }
    for outbox in &runs {
        assert_eq!(
            read(&outbox.path(&report.execution_id).unwrap())
                .unwrap()
                .report,
            report
        );
    }
}

#[test]
fn malformed_records_are_retained_and_invalid_sources_never_enter() {
    let (_fixture, outbox, first, path) = saved_report_fixture();
    fs::write(&path, b"unrecognized").unwrap();
    assert!(outbox.save(&first).is_err());
    assert_eq!(fs::read(&path).unwrap(), b"unrecognized");
    std::fs::File::create(&path)
        .unwrap()
        .set_len(MAX_RECORD_BYTES + 1)
        .unwrap();
    assert!(outbox.save(&first).is_err());
    assert_eq!(fs::metadata(&path).unwrap().len(), MAX_RECORD_BYTES + 1);
    let mut invalid = report();
    invalid.sources[0].channel_id = "other".into();
    assert!(outbox.save(&invalid).is_err());
    invalid = report();
    invalid.sources.push(invalid.sources[0].clone());
    invalid.source_count = 2;
    assert!(outbox.save(&invalid).is_err());
    invalid = report();
    invalid.updated_at_millis = u64::MAX;
    assert!(outbox.save(&invalid).is_err());
    invalid = report();
    invalid.sources[0].sequence = u64::MAX;
    assert!(outbox.save(&invalid).is_err());
    invalid = report();
    invalid.input_disposition = Some("resumed_existing".into());
    invalid.state = "running".into();
    assert!(outbox.save(&invalid).is_err());
}
#[cfg(unix)]
#[test]
fn symlinks_and_nonregular_files_are_rejected_without_touching_targets() {
    use std::os::unix::{
        ffi::OsStrExt,
        fs::{PermissionsExt, symlink},
    };
    let fixture = Fixture::new();
    let outbox = fixture.outbox();
    let first = report();
    outbox.save(&first).unwrap();
    assert_eq!(
        fs::metadata(&outbox.root).unwrap().permissions().mode() & 0o777,
        0o700
    );
    let path = outbox.path(&first.execution_id).unwrap();
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let foreign = fixture.0.join("foreign");
    fs::write(&foreign, b"keep").unwrap();
    fs::remove_file(&path).unwrap();
    symlink(&foreign, &path).unwrap();
    assert!(outbox.save(&first).is_err());
    assert_eq!(fs::read(&foreign).unwrap(), b"keep");
    fs::remove_file(&path).unwrap();
    let c_path = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0);
    assert!(read(&path).is_err());
}

#[test]
fn a_stage_installed_after_directory_enumeration_does_not_fail_admission() {
    let fixture = Fixture::new();
    let outbox = fixture.outbox();
    fs::create_dir_all(&outbox.root).unwrap();
    let staged = outbox.root.join("staged.tmp");
    fs::write(&staged, b"durable report").unwrap();
    let entries = fs::read_dir(&outbox.root).unwrap().collect::<Vec<_>>();
    let installed = outbox.root.join("installed.json");
    fs::rename(&staged, &installed).unwrap();
    let capacity = super::measure_capacity(entries.into_iter(), &installed).unwrap();
    assert!(!capacity.would_exceed(100, true));
    assert_eq!(fs::read(&installed).unwrap(), b"durable report");
    // A directory or symlink cannot be mistaken for an in-flight stage.
    fs::create_dir(outbox.root.join("unexpected-directory")).unwrap();
    assert!(
        outbox
            .capacity(&installed)
            .err()
            .unwrap()
            .contains("unsupported artifact")
    );
}
