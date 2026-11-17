use super::*;
use xmatrix_cli_core::profile::{InstallationRoot, ProfileContext, ProfileId, ProfileStateKind};

const TEST_RUN_ID: &str = "run:unix-handoff";
const TEST_EXECUTION_KEY: &str = "execution:unix-handoff";

struct UnixHandoffFixture {
    root: PathBuf,
    profile: ProfileContext,
    registry: DaemonRunRegistry,
    old_pid: u32,
    candidate_pid: u32,
    candidate: Option<std::process::Child>,
    status_path: PathBuf,
    cleanup: Vec<process_tree::ProcessTreeGuard>,
}

fn spawn_sleep_process() -> std::process::Child {
    std::process::Command::new("sleep")
        .arg("120")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap()
}

fn status_marker(pid: u32, phase: &str, ready: Option<u64>) -> DaemonRunStatusMarker {
    serde_json::from_value(serde_json::json!({
        "pid": pid,
        "phase": phase,
        "completed": phase == "wrapper_startup_failed",
        "delivered": false,
        "updatedAtMillis": unix_millis_now(),
        "wrapperVersion": xmatrix_cli_core::version::current(),
        "wrapperReadyAtMillis": ready,
    }))
    .unwrap()
}

impl UnixHandoffFixture {
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
        let processes = [spawn_sleep_process(), spawn_sleep_process()];
        let cleanup = processes
            .iter()
            .map(process_tree::track_detached_std_child)
            .collect();
        let [old, candidate] = processes;
        let (old_pid, candidate_pid) = (old.id(), candidate.id());
        let status_path = root.join("run.status.json");
        let persisted: PersistedDaemonRun = serde_json::from_value(serde_json::json!({
            "pid": old_pid,
            "runId": TEST_RUN_ID,
            "executionKey": TEST_EXECUTION_KEY,
            "instanceId": "instance:unix-handoff",
            "statusFilePath": status_path,
            "updatedAt": "1",
        }))
        .unwrap();
        let mut managed = daemon_run_child_from_persisted(persisted, None, None);
        managed.process_tree = Some(process_tree::track_detached_std_child(&old));
        managed.child = Some(old);
        persist_daemon_run_sidecar(&persisted_daemon_run_from_child(&managed));
        persist_daemon_run_status_marker_unlocked(
            &status_path,
            &status_marker(
                old_pid,
                "runtime_ready",
                Some(unix_millis_now().saturating_sub(1_000)),
            ),
        );
        Self {
            root,
            profile,
            registry: Arc::new(AsyncMutex::new(HashMap::from([(
                TEST_RUN_ID.into(),
                managed,
            )]))),
            old_pid,
            candidate_pid,
            candidate: Some(candidate),
            status_path,
            cleanup,
        }
    }

    async fn rebind_to(&self, pid: u32) {
        let mut guard = self.registry.lock().await;
        rebind_managed_daemon_run_pid(&mut guard, TEST_RUN_ID, TEST_EXECUTION_KEY, pid).unwrap();
    }

    async fn assert_restored_original(&self) {
        let guard = self.registry.lock().await;
        let run = &guard[TEST_RUN_ID];
        assert_eq!(run.pid, self.old_pid);
        assert!(run.child.is_some());
        assert!(run.process_tree.is_some());
        assert!(run.handoff.is_none());
        assert!(!run.exit_audited);
        assert!(crate::process_tree::process_alive(self.old_pid));
    }

    fn kill_candidate_and_mark_failed(&mut self) {
        if let Some(mut child) = self.candidate.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        persist_daemon_run_status_marker_unlocked(
            &self.status_path,
            &status_marker(self.candidate_pid, "wrapper_startup_failed", None),
        );
    }
}

impl Drop for UnixHandoffFixture {
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

async fn run_with_candidate_handoff<F, Fut>(body: F)
where
    F: FnOnce(UnixHandoffFixture) -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    let fixture = UnixHandoffFixture::new();
    let profile = fixture.profile.clone();
    let candidate_pid = fixture.candidate_pid;
    config::scope_profile_context(profile, async {
        fixture.rebind_to(candidate_pid).await;
        body(fixture).await;
    })
    .await;
}

#[tokio::test]
async fn unix_handoff_candidate_exit_restores_original_without_reporting_run_exit() {
    run_with_candidate_handoff(|mut fixture| async move {
        let old_pid = fixture.old_pid;
        let candidate_pid = fixture.candidate_pid;
        {
            let guard = fixture.registry.lock().await;
            assert_eq!(guard[TEST_RUN_ID].pid, candidate_pid);
            assert!(guard[TEST_RUN_ID].handoff.is_some());
            assert!(guard[TEST_RUN_ID].child.is_none());
        }

        fixture.kill_candidate_and_mark_failed();
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

        fixture.assert_restored_original().await;
        let restored_marker = read_daemon_run_status_marker(Some(&fixture.status_path)).unwrap();
        assert_eq!(restored_marker.pid, old_pid);
        assert_eq!(restored_marker.phase, "runtime_ready");

        // Idempotent rollback: the old wrapper's update-self may also rebind back.
        fixture.rebind_to(old_pid).await;
        assert!(fixture.registry.lock().await[TEST_RUN_ID].child.is_some());
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
    run_with_candidate_handoff(|mut fixture| async move {
        let old_pid = fixture.old_pid;
        let candidate_pid = fixture.candidate_pid;
        fixture.rebind_to(old_pid).await;
        if let Some(mut child) = fixture.candidate.take() {
            let _ = child.wait();
        }
        fixture.assert_restored_original().await;
        assert!(!crate::process_tree::process_alive(candidate_pid));
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
    run_with_candidate_handoff(|fixture| async move {
        let old_pid = fixture.old_pid;
        let candidate_pid = fixture.candidate_pid;
        persist_daemon_run_status_marker_unlocked(
            &fixture.status_path,
            &status_marker(candidate_pid, "runtime_ready", Some(unix_millis_now() + 1)),
        );

        assert!(
            collect_finished_daemon_children(&fixture.registry)
                .await
                .is_empty()
        );

        {
            let guard = fixture.registry.lock().await;
            let run = &guard[TEST_RUN_ID];
            assert_eq!(run.pid, candidate_pid);
            assert!(run.handoff.is_none());
            assert!(crate::process_tree::process_alive(candidate_pid));
        }

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
    run_with_candidate_handoff(|mut fixture| async move {
        let old_pid = fixture.old_pid;
        let persisted = persisted_daemon_run_from_child(&fixture.registry.lock().await[TEST_RUN_ID]);
        fixture.kill_candidate_and_mark_failed();

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
