use super::*;
use xmatrix_cli_core::profile::{InstallationRoot, ProfileContext, ProfileId, ProfileStateKind};

struct UnixHandoffFixture {
    root: PathBuf,
    profile: ProfileContext,
    registry: DaemonRunRegistry,
    old_pid: u32,
    candidate_child: Option<std::process::Child>,
    candidate_pid: u32,
    status_path: PathBuf,
    cleanup: Vec<process_tree::ProcessTreeGuard>,
}

impl UnixHandoffFixture {
    fn spawn_sleeper(seconds: &str) -> std::process::Child {
        let mut command = std::process::Command::new("sleep");
        command
            .arg(seconds)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        detach_daemon_child_process(&mut command);
        command.spawn().expect("spawn detached sleep process")
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
        .expect("build status marker")
    }

    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "xmatrix-unix-handoff-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).expect("create temp root");
        set_daemon_private_dir_permissions(&root);
        let id = ProfileId::new();
        let profile = ProfileContext {
            state_root: InstallationRoot::new(root.clone()).profile_state_root(&id),
            id,
            name: "unix-handoff-test".into(),
            hub_origin: "https://example.invalid".into(),
            registry_revision: 1,
            state_kind: ProfileStateKind::Isolated,
        };
        let [old, candidate] = [Self::spawn_sleeper("120"), Self::spawn_sleeper("120")];
        let (old_pid, candidate_pid) = (old.id(), candidate.id());
        let cleanup = [&old, &candidate]
            .into_iter()
            .map(process_tree::track_detached_std_child)
            .collect();
        let status_path = root.join("run.status.json");
        let run = PersistedDaemonRun {
            pid: old_pid,
            run_id: Some("run:unix-handoff".into()),
            execution_key: Some("execution:unix-handoff".into()),
            instance_id: Some("instance:unix-handoff".into()),
            status_file_path: Some(status_path.clone()),
            ..crate::tests::test_empty_persisted_daemon_run()
        };
        let mut managed = daemon_run_child_from_persisted(run, None, None);
        managed.process_tree = Some(process_tree::track_detached_std_child(&old));
        managed.child = Some(old);
        persist_daemon_run_status_marker_unlocked(
            &status_path,
            &Self::status_marker(
                old_pid,
                "channel_joined",
                Some(unix_millis_now().saturating_sub(1_000)),
            ),
        );
        persist_daemon_run_sidecar(&persisted_daemon_run_from_child(&managed));
        Self {
            root,
            profile,
            registry: Arc::new(AsyncMutex::new(HashMap::from([(
                daemon_run_key("run", "run:unix-handoff"),
                managed,
            )]))),
            old_pid,
            candidate_child: Some(candidate),
            candidate_pid,
            status_path,
            cleanup,
        }
    }

    async fn begin_rebind(&self) {
        let mut guard = self.registry.lock().await;
        let (_key, prior_pid) = rebind_managed_daemon_run_pid(
            &mut guard,
            "run:unix-handoff",
            "execution:unix-handoff",
            self.candidate_pid,
        )
        .expect("rebind run to replacement pid");
        assert_eq!(prior_pid, self.old_pid);
        let run = guard
            .get(&daemon_run_key("run", "run:unix-handoff"))
            .expect("managed run remains registered");
        assert_eq!(run.pid, self.candidate_pid);
        assert!(run.handoff.is_some());
        persist_daemon_run_sidecar(&persisted_daemon_run_from_child(run));
    }

    fn kill_and_reap_candidate(&mut self) {
        let mut child = self
            .candidate_child
            .take()
            .expect("candidate child handle still owned");
        let _ = child.kill();
        let _ = child.wait();
    }

    fn candidate_was_terminated(&mut self) -> bool {
        if let Some(child) = self.candidate_child.as_mut()
            && child.try_wait().ok().flatten().is_some()
        {
            return true;
        }
        !crate::process_tree::process_alive(self.candidate_pid)
    }

    async fn expire_handoff_clock(&self, key: &str) {
        let mut guard = self.registry.lock().await;
        let handoff = guard
            .get_mut(key)
            .and_then(|managed| managed.handoff.as_mut())
            .expect("active handoff");
        handoff.started_millis = unix_millis_now() - (UPDATE_SELF_READY_TIMEOUT_SECS + 1) * 1000;
    }

    fn roundtrip_sidecar(run: &DaemonRunChild) -> PersistedDaemonRun {
        let json = serde_json::to_string(&persisted_daemon_run_from_child(run))
            .expect("serialize persisted run");
        serde_json::from_str(&json).expect("deserialize persisted run")
    }
}

impl Drop for UnixHandoffFixture {
    fn drop(&mut self) {
        if let Some(mut child) = self.candidate_child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        for tree in &mut self.cleanup {
            let _ = tree.terminate();
        }
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[tokio::test]
async fn unix_failed_replacement_rolls_back_to_original_wrapper_without_reporting_run_exit() {
    let mut fixture = UnixHandoffFixture::new();
    config::scope_profile_context(fixture.profile.clone(), async {
        fixture.begin_rebind().await;

        // Replacement writes startup failure (e.g. Codex active-writer refusal)
        // and exits before becoming ready.
        persist_daemon_run_status_marker_unlocked(
            &fixture.status_path,
            &UnixHandoffFixture::status_marker(
                fixture.candidate_pid,
                "wrapper_startup_failed",
                None,
            ),
        );
        {
            let guard = fixture.registry.lock().await;
            let snapshots = daemon_run_snapshot_items_from_guard(&guard);
            assert_eq!(snapshots[0].pid, Some(fixture.old_pid));
            assert_ne!(
                snapshots[0].status_phase.as_deref(),
                Some("wrapper_startup_failed")
            );
        }
        fixture.kill_and_reap_candidate();

        // Monitor sweep must NOT emit a Run exit for the dead replacement;
        // instead it restores the original wrapper, its status marker, and its sidecar.
        let exits = collect_finished_daemon_children(&fixture.registry).await;
        assert!(
            exits.is_empty(),
            "failed replacement exit must never report the Run as finished"
        );

        let key = daemon_run_key("run", "run:unix-handoff");
        {
            let mut guard = fixture.registry.lock().await;
            let run = guard.get(&key).expect("original Run must stay registered");
            assert_eq!(run.pid, fixture.old_pid);
            assert!(run.child.is_some());
            assert!(run.process_tree.is_some());
            assert!(run.handoff.is_none());
            assert!(!run.exit_audited);
            assert!(crate::process_tree::process_alive(fixture.old_pid));
            assert_eq!(
                read_daemon_run_status_marker(Some(&fixture.status_path))
                    .expect("restored status")
                    .pid,
                fixture.old_pid
            );
            assert_eq!(
                read_daemon_run_status_marker(Some(&fixture.status_path))
                    .expect("restored status")
                    .phase,
                "channel_joined"
            );
            let sidecar_path =
                daemon_run_sidecar_path_for_status(&fixture.status_path).expect("sidecar path");
            let sidecar: PersistedDaemonRun =
                serde_json::from_str(&std::fs::read_to_string(sidecar_path).unwrap()).unwrap();
            assert_eq!(sidecar.pid, fixture.old_pid);
            assert!(sidecar.handoff.is_none());

            // update-self's subsequent rollback rebind is idempotent.
            rebind_managed_daemon_run_pid(
                &mut guard,
                "run:unix-handoff",
                "execution:unix-handoff",
                fixture.old_pid,
            )
            .expect("idempotent rollback rebind succeeds");
        }
        assert!(
            collect_finished_daemon_children(&fixture.registry)
                .await
                .is_empty()
        );
    })
    .await;
}

#[tokio::test]
async fn unix_update_self_explicit_rollback_rebind_restores_original_immediately() {
    let mut fixture = UnixHandoffFixture::new();
    config::scope_profile_context(fixture.profile.clone(), async {
        fixture.begin_rebind().await;

        let key = daemon_run_key("run", "run:unix-handoff");
        {
            let mut guard = fixture.registry.lock().await;
            let (_key, candidate_pid) = rebind_managed_daemon_run_pid(
                &mut guard,
                "run:unix-handoff",
                "execution:unix-handoff",
                fixture.old_pid,
            )
            .expect("explicit rollback rebind to old pid succeeds");
            assert_eq!(candidate_pid, fixture.candidate_pid);
            let run = guard.get(&key).expect("Run remains registered");
            assert_eq!(run.pid, fixture.old_pid);
            assert!(run.child.is_some());
            assert!(run.process_tree.is_some());
            assert!(run.handoff.is_none());
        }
        assert!(crate::process_tree::process_alive(fixture.old_pid));
        assert!(fixture.candidate_was_terminated());
    })
    .await;
}

#[tokio::test]
async fn unix_handoff_timeout_stops_only_candidate_and_keeps_original() {
    let mut fixture = UnixHandoffFixture::new();
    config::scope_profile_context(fixture.profile.clone(), async {
        fixture.begin_rebind().await;
        let key = daemon_run_key("run", "run:unix-handoff");
        fixture.expire_handoff_clock(&key).await;

        assert!(
            collect_finished_daemon_children(&fixture.registry)
                .await
                .is_empty()
        );
        assert!(crate::process_tree::process_alive(fixture.old_pid));
        assert!(fixture.candidate_was_terminated());
        assert_eq!(fixture.registry.lock().await[&key].pid, fixture.old_pid);
    })
    .await;
}

#[tokio::test]
async fn unix_unreaped_zombie_candidate_still_triggers_rollback() {
    let mut fixture = UnixHandoffFixture::new();
    config::scope_profile_context(fixture.profile.clone(), async {
        fixture.begin_rebind().await;
        let _ = fixture.candidate_child.as_mut().unwrap().kill();
        // Wait briefly for the kernel to turn the killed child into a zombie
        // without calling Child::wait().
        tokio::time::sleep(Duration::from_millis(50)).await;

        assert!(
            collect_finished_daemon_children(&fixture.registry)
                .await
                .is_empty()
        );
        let key = daemon_run_key("run", "run:unix-handoff");
        let guard = fixture.registry.lock().await;
        assert_eq!(guard[&key].pid, fixture.old_pid);
        assert!(guard[&key].handoff.is_none());
        assert!(crate::process_tree::process_alive(fixture.old_pid));
    })
    .await;
}

#[tokio::test]
async fn unix_ready_candidate_commits_and_stops_only_original_wrapper() {
    let fixture = UnixHandoffFixture::new();
    config::scope_profile_context(fixture.profile.clone(), async {
        fixture.begin_rebind().await;
        let key = daemon_run_key("run", "run:unix-handoff");
        persist_daemon_run_status_marker_unlocked(
            &fixture.status_path,
            &UnixHandoffFixture::status_marker(
                fixture.candidate_pid,
                "channel_joined",
                Some(unix_millis_now()),
            ),
        );

        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                assert!(
                    collect_finished_daemon_children(&fixture.registry)
                        .await
                        .is_empty()
                );
                if fixture.registry.lock().await[&key].handoff.is_none() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("ready Unix handoff must commit within 5 seconds");

        let guard = fixture.registry.lock().await;
        assert_eq!(guard[&key].pid, fixture.candidate_pid);
        assert!(crate::process_tree::process_alive(fixture.candidate_pid));
        assert!(!crate::process_tree::process_alive(fixture.old_pid));
    })
    .await;
}

#[tokio::test]
async fn unix_handoff_daemon_restart_recovers_and_rolls_back_to_original() {
    let mut fixture = UnixHandoffFixture::new();
    config::scope_profile_context(fixture.profile.clone(), async {
        fixture.begin_rebind().await;
        let key = daemon_run_key("run", "run:unix-handoff");
        let recovered = UnixHandoffFixture::roundtrip_sidecar(&fixture.registry.lock().await[&key]);
        fixture.kill_and_reap_candidate();
        assert!(daemon_run_sidecar_is_recoverable(&recovered));

        let restored = daemon_run_child_from_persisted(recovered.clone(), None, None);
        assert_eq!(restored.pid, fixture.old_pid);
        assert!(restored.handoff.is_none());
        assert!(crate::process_tree::process_alive(fixture.old_pid));

        // A recycled pid whose start time differs from the recorded predecessor
        // must never be restored.
        let mut stale_pid = recovered;
        stale_pid.handoff.as_mut().unwrap().previous_start_time = Some(1);
        assert!(!daemon_run_sidecar_is_recoverable(&stale_pid));
        let rejected = daemon_run_child_from_persisted(stale_pid, None, None);
        assert_eq!(rejected.pid, fixture.candidate_pid);
    })
    .await;
}

#[tokio::test]
async fn unix_handoff_stop_terminates_both_original_and_candidate() {
    let mut fixture = UnixHandoffFixture::new();
    config::scope_profile_context(fixture.profile.clone(), async {
        fixture.begin_rebind().await;
        stop_daemon_child(
            &fixture.registry,
            Some("run:unix-handoff"),
            Some("execution:unix-handoff"),
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
        .expect("stop mid-handoff succeeds");

        assert!(!crate::process_tree::process_alive(fixture.old_pid));
        assert!(fixture.candidate_was_terminated());
        assert!(fixture.registry.lock().await.is_empty());
        assert!(
            collect_finished_daemon_children(&fixture.registry)
                .await
                .is_empty()
        );
    })
    .await;
}
