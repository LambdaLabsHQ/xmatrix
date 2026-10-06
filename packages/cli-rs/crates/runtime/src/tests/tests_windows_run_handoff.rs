use super::*;
use std::os::windows::process::CommandExt;
use xmatrix_cli_core::profile::{InstallationRoot, ProfileContext, ProfileId, ProfileStateKind};

struct Fixture {
    root: PathBuf,
    profile: ProfileContext,
    registry: DaemonRunRegistry,
    old_pid: u32,
    candidate_pid: u32,
    status_path: PathBuf,
    cleanup: Vec<process_tree::ProcessTreeGuard>,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("xmatrix-handoff-{}", uuid::Uuid::new_v4()));
        let id = ProfileId::new();
        let profile = ProfileContext {
            state_root: InstallationRoot::new(root.clone()).profile_state_root(&id),
            id,
            name: "handoff-test".into(),
            hub_origin: "https://example.invalid".into(),
            registry_revision: 1,
            state_kind: ProfileStateKind::Isolated,
        };
        let spawn = || {
            std::process::Command::new("powershell.exe")
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    "Start-Sleep -Seconds 120",
                ])
                .creation_flags(0x0800_0000)
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
            "pid": candidate_pid, "runId": "run:handoff", "executionKey": "execution:handoff",
            "instanceId": "instance:handoff", "statusFilePath": status_path, "updatedAt": "1",
        }))
        .unwrap();
        let mut managed = daemon_run_child_from_persisted(run, None, None);
        let previous_status = marker(old_pid, Some(unix_millis_now().saturating_sub(1_000)));
        let evidence = xmatrix_windows_continuity::RunEvidence {
            run_id: "run:handoff".into(),
            execution_key: "execution:handoff".into(),
            instance_id: "instance:handoff".into(),
            pid: old_pid,
            process_birth_id: runtime_windows_run_adoption::process_birth_id(old_pid).unwrap(),
            executable_sha256: "a".repeat(64),
            wrapper_nonce: "b".repeat(32),
            adoption_key_hash: "c".repeat(64),
            job_name: "test-job".into(),
            protocol_major: xmatrix_windows_continuity::SUPERVISOR_PROTOCOL_MAJOR,
            executable_path: PathBuf::from("powershell.exe"),
            adoption_public_key: "test-public-key".into(),
            control_locator: "tcp://127.0.0.1:1".into(),
        };
        managed.handoff = Some(WindowsRunHandoff {
            previous_pid: old_pid,
            previous_tree: Some(process_tree::track_detached_std_child(&old)),
            previous_child: Some(old),
            previous_evidence: evidence,
            previous_status,
            started_millis: unix_millis_now(),
        });
        managed.process_tree = Some(process_tree::track_detached_std_child(&candidate));
        managed.child = Some(candidate);
        persist_daemon_run_sidecar(&persisted_daemon_run_from_child(&managed));
        persist_daemon_run_status_marker_unlocked(&status_path, &marker(candidate_pid, None));
        Self {
            root,
            profile,
            registry: Arc::new(AsyncMutex::new(HashMap::from([(
                "run:handoff".into(),
                managed,
            )]))),
            old_pid,
            candidate_pid,
            status_path,
            cleanup,
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        for tree in &mut self.cleanup {
            let _ = tree.terminate();
        }
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn marker(pid: u32, ready: Option<u64>) -> DaemonRunStatusMarker {
    serde_json::from_value(serde_json::json!({
        "pid": pid, "phase": "runtime_ready", "completed": false, "delivered": false,
        "updatedAtMillis": unix_millis_now(), "wrapperVersion": xmatrix_cli_core::version::current(),
        "wrapperReadyAtMillis": ready,
    }))
    .unwrap()
}

#[test]
fn handoff_restored_auth_uses_the_exact_admitted_grant() {
    let broker = DaemonAuthBroker {
        url: "http://127.0.0.1:1".into(),
        session_reload_capability: "owner-only".into(),
        capabilities: Arc::new(Mutex::new(HashMap::new())),
        git_credentials: Arc::new(Mutex::new(HashMap::new())),
    };
    let context = DaemonAgentAuthContext {
        agent_id: "agent".into(),
        agent_name: "codex".into(),
        space_id: "space".into(),
        channel_id: "channel".into(),
        run_id: "run".into(),
        execution_key: "execution".into(),
    };
    let grant = broker
        .restore_grant_key(daemon_capability_key("original-secret"), context.clone())
        .unwrap();
    assert!(
        grant.capability.is_empty(),
        "restart cannot recover the raw secret"
    );
    assert_eq!(
        take_daemon_agent_auth_grant(&broker.capabilities, grant.broker_capability())
            .unwrap()
            .0,
        context
    );
    assert!(take_daemon_agent_auth_grant(&broker.capabilities, "wrong-secret").is_none());
    assert!(
        take_daemon_agent_auth_grant(&broker.capabilities, &broker.session_reload_capability)
            .is_none()
    );
    drop(grant);
    assert!(take_daemon_agent_auth_grant(&broker.capabilities, "original-secret").is_none());
}

#[tokio::test]
async fn handoff_candidate_exit_cannot_report_the_live_run_as_finished() {
    let fixture = Fixture::new();
    config::scope_profile_context(fixture.profile.clone(), async {
        {
            let mut guard = fixture.registry.lock().await;
            let run = guard.get_mut("run:handoff").unwrap();
            reap_handoff_candidate(run);
            let mut failure = marker(fixture.candidate_pid, None);
            failure.phase = "wrapper_startup_failed".into();
            failure.completed = true;
            persist_daemon_run_status_marker_unlocked(&fixture.status_path, &failure);
            let snapshots = daemon_run_snapshot_items_from_guard(&guard);
            assert_eq!(snapshots[0].pid, Some(fixture.old_pid));
            assert_ne!(
                snapshots[0].status_phase.as_deref(),
                Some("wrapper_startup_failed")
            );
        }
        assert!(
            collect_finished_daemon_children(&fixture.registry)
                .await
                .is_empty()
        );
        let mut guard = fixture.registry.lock().await;
        let run = guard.get_mut("run:handoff").unwrap();
        assert_eq!(run.pid, fixture.old_pid);
        assert!(run.child.is_some() && run.process_tree.is_some() && run.handoff.is_none());
        assert!(!run.exit_audited);
        assert!(crate::process_tree::process_alive(fixture.old_pid));
        assert_eq!(
            read_daemon_run_status_marker(Some(&fixture.status_path))
                .unwrap()
                .pid,
            fixture.old_pid
        );
        assert_eq!(
            runtime_windows_run_adoption::read_evidence(&fixture.status_path)
                .unwrap()
                .pid,
            fixture.old_pid
        );
        // The old helper may ask to roll back after the monitor already did it.
        rebind_managed_daemon_run_pid(
            &mut guard,
            "run:handoff",
            "execution:handoff",
            fixture.old_pid,
        )
        .unwrap();
        assert!(
            guard["run:handoff"].child.is_some(),
            "idempotent rollback retains ownership"
        );
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
async fn handoff_readiness_and_timeout_keep_the_old_process_until_proven_ready() {
    let fixture = Fixture::new();
    config::scope_profile_context(fixture.profile.clone(), async {
        assert!(
            collect_finished_daemon_children(&fixture.registry)
                .await
                .is_empty()
        );
        assert!(crate::process_tree::process_alive(fixture.old_pid));
        let stale = marker(fixture.candidate_pid, Some(1));
        persist_daemon_run_status_marker_unlocked(&fixture.status_path, &stale);
        assert!(
            collect_finished_daemon_children(&fixture.registry)
                .await
                .is_empty()
        );
        assert!(
            fixture.registry.lock().await["run:handoff"]
                .handoff
                .is_some()
        );
        fixture
            .registry
            .lock()
            .await
            .get_mut("run:handoff")
            .unwrap()
            .handoff
            .as_mut()
            .unwrap()
            .started_millis = unix_millis_now() - (UPDATE_SELF_READY_TIMEOUT_SECS + 1) * 1000;
        assert!(
            collect_finished_daemon_children(&fixture.registry)
                .await
                .is_empty()
        );
        assert!(crate::process_tree::process_alive(fixture.old_pid));
        assert!(!crate::process_tree::process_alive(fixture.candidate_pid));
        assert_eq!(
            fixture.registry.lock().await["run:handoff"].pid,
            fixture.old_pid
        );
    })
    .await;
}

#[tokio::test]
async fn handoff_ready_candidate_commits_and_stops_only_the_old_tree() {
    let fixture = Fixture::new();
    config::scope_profile_context(fixture.profile.clone(), async {
        persist_daemon_run_status_marker_unlocked(
            &fixture.status_path,
            &marker(fixture.candidate_pid, Some(unix_millis_now())),
        );
        assert!(
            collect_finished_daemon_children(&fixture.registry)
                .await
                .is_empty()
        );
        let guard = fixture.registry.lock().await;
        assert!(guard["run:handoff"].handoff.is_none());
        assert_eq!(guard["run:handoff"].pid, fixture.candidate_pid);
        assert!(crate::process_tree::process_alive(fixture.candidate_pid));
        assert!(!crate::process_tree::process_alive(fixture.old_pid));
    })
    .await;
}

#[tokio::test]
async fn handoff_daemon_restart_restores_original_after_candidate_failure() {
    let fixture = Fixture::new();
    config::scope_profile_context(fixture.profile.clone(), async {
        let persisted = {
            let mut guard = fixture.registry.lock().await;
            let run = guard.get_mut("run:handoff").unwrap();
            reap_handoff_candidate(run);
            persisted_daemon_run_from_child(run)
        };
        let wire = serde_json::to_string(&persisted).unwrap();
        let recovered: PersistedDaemonRun = serde_json::from_str(&wire).unwrap();
        assert!(daemon_run_sidecar_is_recoverable(&recovered));
        let restored = daemon_run_child_from_persisted(recovered, None, None);
        assert_eq!(restored.pid, fixture.old_pid);
        assert!(restored.handoff.is_none());
        assert!(crate::process_tree::process_alive(fixture.old_pid));
        assert_eq!(
            runtime_windows_run_adoption::read_evidence(&fixture.status_path)
                .unwrap()
                .pid,
            fixture.old_pid
        );

        let mut mismatched: PersistedDaemonRun = serde_json::from_str(&wire).unwrap();
        mismatched
            .handoff
            .as_mut()
            .unwrap()
            .previous_evidence
            .execution_key = "other-execution".into();
        assert!(!daemon_run_sidecar_is_recoverable(&mismatched));
        let rejected = daemon_run_child_from_persisted(mismatched, None, None);
        assert_eq!(
            rejected.pid, fixture.candidate_pid,
            "another execution is never restored"
        );
        assert!(crate::process_tree::process_alive(fixture.old_pid));
    })
    .await;
}

#[tokio::test]
async fn handoff_stop_fences_other_executions_and_terminates_both_trees() {
    let fixture = Fixture::new();
    config::scope_profile_context(fixture.profile.clone(), async {
        // stop_daemon_child uses the registry's canonical Run key.
        let run = fixture.registry.lock().await.remove("run:handoff").unwrap();
        fixture
            .registry
            .lock()
            .await
            .insert("run:run:handoff".into(), run);
        assert!(
            stop_daemon_child(
                &fixture.registry,
                Some("run:handoff"),
                Some("other-execution"),
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                Some("test")
            )
            .await
            .is_err()
        );
        assert!(
            crate::process_tree::process_alive(fixture.old_pid)
                && crate::process_tree::process_alive(fixture.candidate_pid)
        );
        stop_daemon_child(
            &fixture.registry,
            Some("run:handoff"),
            Some("execution:handoff"),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            Some("test"),
        )
        .await
        .unwrap();
        assert!(
            !crate::process_tree::process_alive(fixture.old_pid)
                && !crate::process_tree::process_alive(fixture.candidate_pid)
        );
        assert!(fixture.registry.lock().await.is_empty());
        assert!(
            collect_finished_daemon_children(&fixture.registry)
                .await
                .is_empty()
        );
    })
    .await;
}

fn reap_handoff_candidate(run: &mut DaemonRunChild) {
    run.child.as_mut().unwrap().kill().unwrap();
    run.child.as_mut().unwrap().wait().unwrap();
}
