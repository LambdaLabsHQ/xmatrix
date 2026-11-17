use super::*;
use xmatrix_cli_core::profile::{InstallationRoot, ProfileContext, ProfileId, ProfileStateKind};

struct Fixture {
    root: PathBuf,
    profile: ProfileContext,
    registry: DaemonRunRegistry,
    old_pid: u32,
    candidate_pid: u32,
    candidate: Option<std::process::Child>,
    status_path: PathBuf,
    cleanup: Vec<process_tree::ProcessTreeGuard>,
}

impl Fixture {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("xmatrix-unix-handoff-{}", uuid::Uuid::new_v4()));
        let id = ProfileId::new();
        let profile = ProfileContext {
            state_root: InstallationRoot::new(root.clone()).profile_state_root(&id),
            id,
            name: "unix-handoff-test".into(),
            hub_origin: "https://example.invalid".into(),
            registry_revision: 1,
            state_kind: ProfileStateKind::Isolated,
        };
        let spawn = || {
            std::process::Command::new("sleep")
                .arg("120")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap()
        };
        let old = spawn();
        let candidate = spawn();
        let old_pid = old.id();
        let candidate_pid = candidate.id();
        let cleanup = vec![
            process_tree::track_detached_std_child(&old),
            process_tree::track_detached_std_child(&candidate),
        ];
        let status_path = root.join("run.status.json");
        let run: PersistedDaemonRun = serde_json::from_value(serde_json::json!({
            "pid": old_pid,
            "runId": "run:unix-handoff",
            "executionKey": "execution:unix-handoff",
            "instanceId": "instance:unix-handoff",
            "statusFilePath": status_path,
            "updatedAt": "1",
        }))
        .unwrap();
        let mut managed = daemon_run_child_from_persisted(run, None, None);
        managed.process_tree = Some(process_tree::track_detached_std_child(&old));
        managed.child = Some(old);
        persist_daemon_run_sidecar(&persisted_daemon_run_from_child(&managed));
        persist_daemon_run_status_marker_unlocked(
            &status_path,
            &marker(old_pid, Some(unix_millis_now().saturating_sub(1_000))),
        );
        Self {
            root,
            profile,
            registry: Arc::new(AsyncMutex::new(HashMap::from([(
                "run:unix-handoff".into(),
                managed,
            )]))),
            old_pid,
            candidate_pid,
            candidate: Some(candidate),
            status_path,
            cleanup,
        }
    }

    fn kill_candidate(&mut self) {
        if let Some(mut child) = self.candidate.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(mut child) = self.candidate.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        for tree in &mut self.cleanup {
            let _ = tree.terminate();
        }
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn marker(pid: u32, ready: Option<u64>) -> DaemonRunStatusMarker {
    serde_json::from_value(serde_json::json!({
        "pid": pid,
        "phase": "runtime_ready",
        "completed": false,
        "delivered": false,
        "updatedAtMillis": unix_millis_now(),
        "wrapperVersion": xmatrix_cli_core::version::current(),
        "wrapperReadyAtMillis": ready,
    }))
    .unwrap()
}

#[tokio::test]
async fn unix_handoff_candidate_exit_restores_original_without_reporting_run_exit() {
    let mut fixture = Fixture::new();
    let old_pid = fixture.old_pid;
    let candidate_pid = fixture.candidate_pid;
    config::scope_profile_context(fixture.profile.clone(), async {
        {
            let mut guard = fixture.registry.lock().await;
            rebind_managed_daemon_run_pid(
                &mut guard,
                "run:unix-handoff",
                "execution:unix-handoff",
                candidate_pid,
            )
            .unwrap();
            assert_eq!(guard["run:unix-handoff"].pid, candidate_pid);
            assert!(guard["run:unix-handoff"].handoff.is_some());
            assert!(guard["run:unix-handoff"].child.is_none());
        }

        fixture.kill_candidate();
        let mut failure = marker(candidate_pid, None);
        failure.phase = "wrapper_startup_failed".into();
        failure.completed = true;
        persist_daemon_run_status_marker_unlocked(&fixture.status_path, &failure);

        {
            let guard = fixture.registry.lock().await;
            let snapshots = daemon_run_snapshot_items_from_guard(&guard);
            assert_eq!(snapshots[0].pid, Some(old_pid));
            assert_ne!(
                snapshots[0].status_phase.as_deref(),
                Some("wrapper_startup_failed")
            );
        }

        assert!(
            collect_finished_daemon_children(&fixture.registry)
                .await
                .is_empty(),
            "candidate startup failure must not report the live Run as exited"
        );

        let mut guard = fixture.registry.lock().await;
        let run = guard.get_mut("run:unix-handoff").unwrap();
        assert_eq!(run.pid, old_pid);
        assert!(run.child.is_some());
        assert!(run.process_tree.is_some());
        assert!(run.handoff.is_none());
        assert!(!run.exit_audited);
        assert!(crate::process_tree::process_alive(old_pid));
        let restored_marker = read_daemon_run_status_marker(Some(&fixture.status_path)).unwrap();
        assert_eq!(restored_marker.pid, old_pid);
        assert_eq!(restored_marker.phase, "runtime_ready");

        // Idempotent rollback: the old wrapper's update-self may also rebind back.
        rebind_managed_daemon_run_pid(
            &mut guard,
            "run:unix-handoff",
            "execution:unix-handoff",
            old_pid,
        )
        .unwrap();
        assert!(guard["run:unix-handoff"].child.is_some());
        drop(guard);
        assert!(
            collect_finished_daemon_children(&fixture.registry)
                .await
                .is_empty()
        );
    })
    .await;
}

#[tokio::test]
async fn unix_handoff_explicit_rollback_before_monitor_sweep_restores_original() {
    let mut fixture = Fixture::new();
    let old_pid = fixture.old_pid;
    let candidate_pid = fixture.candidate_pid;
    config::scope_profile_context(fixture.profile.clone(), async {
        let mut guard = fixture.registry.lock().await;
        rebind_managed_daemon_run_pid(
            &mut guard,
            "run:unix-handoff",
            "execution:unix-handoff",
            candidate_pid,
        )
        .unwrap();

        rebind_managed_daemon_run_pid(
            &mut guard,
            "run:unix-handoff",
            "execution:unix-handoff",
            old_pid,
        )
        .unwrap();
        drop(guard);
        if let Some(mut child) = fixture.candidate.take() {
            let _ = child.wait();
        }
        let guard = fixture.registry.lock().await;
        let run = &guard["run:unix-handoff"];
        assert_eq!(run.pid, old_pid);
        assert!(run.child.is_some());
        assert!(run.process_tree.is_some());
        assert!(run.handoff.is_none());
        assert!(!crate::process_tree::process_alive(candidate_pid));
        drop(guard);
        assert!(
            collect_finished_daemon_children(&fixture.registry)
                .await
                .is_empty()
        );
    })
    .await;
}

#[tokio::test]
async fn unix_handoff_ready_candidate_commits_and_stops_original() {
    let fixture = Fixture::new();
    let old_pid = fixture.old_pid;
    let candidate_pid = fixture.candidate_pid;
    config::scope_profile_context(fixture.profile.clone(), async {
        {
            let mut guard = fixture.registry.lock().await;
            rebind_managed_daemon_run_pid(
                &mut guard,
                "run:unix-handoff",
                "execution:unix-handoff",
                candidate_pid,
            )
            .unwrap();
        }
        persist_daemon_run_status_marker_unlocked(
            &fixture.status_path,
            &marker(candidate_pid, Some(unix_millis_now() + 1)),
        );

        assert!(
            collect_finished_daemon_children(&fixture.registry)
                .await
                .is_empty()
        );

        let guard = fixture.registry.lock().await;
        let run = &guard["run:unix-handoff"];
        assert_eq!(run.pid, candidate_pid);
        assert!(run.handoff.is_none());
        assert!(crate::process_tree::process_alive(candidate_pid));
        drop(guard);

        tokio::time::timeout(Duration::from_secs(5), async {
            while crate::process_tree::process_alive(old_pid) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("committed handoff must stop and reap the original wrapper");
    })
    .await;
}

#[tokio::test]
async fn unix_handoff_daemon_restart_recovers_and_restores_original() {
    let mut fixture = Fixture::new();
    let old_pid = fixture.old_pid;
    let candidate_pid = fixture.candidate_pid;
    config::scope_profile_context(fixture.profile.clone(), async {
        let persisted = {
            let mut guard = fixture.registry.lock().await;
            rebind_managed_daemon_run_pid(
                &mut guard,
                "run:unix-handoff",
                "execution:unix-handoff",
                candidate_pid,
            )
            .unwrap();
            persisted_daemon_run_from_child(&guard["run:unix-handoff"])
        };

        fixture.kill_candidate();
        let mut failure = marker(candidate_pid, None);
        failure.phase = "wrapper_startup_failed".into();
        failure.completed = true;
        persist_daemon_run_status_marker_unlocked(&fixture.status_path, &failure);

        let restored = daemon_run_child_from_persisted(persisted, None, None);
        assert_eq!(restored.pid, old_pid);
        assert!(restored.handoff.is_none());
        assert_eq!(
            read_daemon_run_status_marker(Some(&fixture.status_path))
                .unwrap()
                .pid,
            old_pid
        );
    })
    .await;
}
