#[tokio::test]
async fn retained_handoff_exports_exact_work_before_and_after_eviction() {
    let _floors = NoIdleFloors::enter();
    let identity_url = "https://github.com/acme/retained-handoff";
    let (base, remote) = setup_base_with_local_fetch(identity_url);
    let pools = unique_temp("he");
    let layout = layout_for(identity_url, &pools);
    let request = req("he1");
    let lease = lease_available_or_create_at(&layout, &base, identity_url, &request)
        .await
        .unwrap();
    commit_unpushed_work(&lease.worktree_path, "feat/unfinished");
    std::fs::write(lease.worktree_path.join("draft.txt"), "half done\n").unwrap();
    let exact = BindingAuthority {
        session_key: request.session_key.clone(),
        instance_id: request.instance_id.clone(),
        run_id: request.run_id.clone(),
        execution_key: request.execution_key.clone(),
        slot_id: lease.slot_id.as_str().to_string(),
    };
    assert!(
        retained_handoff_source_at(&layout, &exact).await.is_err(),
        "live lease is not a sleeping source"
    );
    mark_retained_at(&layout, &request).await.unwrap();
    for field in ["session", "instance", "run", "execution", "slot"] {
        let mut stale = exact.clone();
        match field {
            "session" => stale.session_key = "another".into(),
            "instance" => stale.instance_id = "another".into(),
            "run" => stale.run_id = "another".into(),
            "execution" => stale.execution_key = "another".into(),
            _ => stale.slot_id = "a".repeat(32),
        }
        assert!(
            retained_handoff_source_at(&layout, &stale).await.is_err(),
            "stale {field}"
        );
    }
    let source = retained_handoff_source_at(&layout, &exact).await.unwrap();
    assert_eq!(source.cwd, lease.worktree_path);
    assert!(source.captured.is_none());
    // A reclaim cannot remove the checkout while an export owns it.
    assert!(
        tokio::time::timeout(
            std::time::Duration::from_millis(50),
            reclaim_pool_slots_at(&pools, &PoolLiveness::default(), 8)
        )
        .await
        .is_err()
    );
    let work = crate::run_worktree::capture_handoff_work(&source.cwd, "sleeping source")
        .await
        .unwrap();
    crate::run_worktree::push_handoff_work(&source.cwd, &work.commit, "xmatrix/handoff/retained")
        .await
        .unwrap();
    drop(source);
    let outcome = reclaim_pool_slots_at(&pools, &PoolLiveness::default(), 8).await;
    assert_evicted_tree(&outcome, lease.slot_id.as_str(), &lease.worktree_path);
    let source = retained_handoff_source_at(&layout, &exact).await.unwrap();
    let captured = source.captured.as_ref().unwrap();
    assert!(captured.dirty);
    crate::run_worktree::push_handoff_work(
        &source.cwd,
        &captured.commit,
        "xmatrix/handoff/evicted",
    )
    .await
    .unwrap();
    for branch in ["retained", "evicted"] {
        for (file, expected) in [("landed.txt", "committed"), ("draft.txt", "half done")] {
            assert_eq!(
                git(
                    &remote,
                    &[
                        "show",
                        &format!("refs/heads/xmatrix/handoff/{branch}:{file}")
                    ],
                    GIT_LOCAL_TIMEOUT
                )
                .await
                .unwrap(),
                expected
            );
        }
    }
    let mut stale = exact.clone();
    stale.run_id = "later-run".into();
    drop(source);
    assert!(
        retained_handoff_source_at(&layout, &stale).await.is_err(),
        "evicted source still requires exact Run"
    );
    cleanup_test_dirs(&[&base, &remote, &pools]);
}
