#[tokio::test]
async fn baseline_tracks_actual_fetch_tip_and_avoids_false_rewrite_notices() {
    if !git_available() {
        return;
    }
    let (base, remote) = setup_base_with_local_fetch("https://github.com/acme/baseline-race");
    let old = rev(&remote, "main");
    let advertised = commit_on_remote(&remote, &old, "advertised");
    let fetched_tip = commit_on_remote(&remote, &advertised, "moved before fetch");
    run_git(&remote, &["update-ref", "refs/heads/main", &fetched_tip]);
    let resolved = materialize_advertised_default(&base, "main", &advertised, now_rfc3339())
        .await
        .ok()
        .expect("confirmation");
    assert_eq!(
        resolved.oid, fetched_tip,
        "the fetched tip, not ls-remote's earlier tip"
    );
    assert_eq!(resolved.history_rewritten, Some(false));
    validate_updated_at(&resolved.confirmed_at).unwrap();
    let path = unique_temp("actual-base");
    std::fs::remove_dir(&path).unwrap();
    let (_, used) = create_linked_slot_required_fetch(&base, &path, &resolved)
        .await
        .unwrap();
    assert_eq!(used, fetched_tip);
    assert_eq!(rev(&path, "HEAD"), used);

    run_git(&remote, &["update-ref", "refs/heads/main", &old]);
    let rollback = confirm_origin_default_once(&base).await.ok().unwrap();
    assert_eq!(rollback.history_rewritten, Some(true));
    run_git(&remote, &["update-ref", "refs/heads/trunk", &advertised]);
    run_git(&remote, &["symbolic-ref", "HEAD", "refs/heads/trunk"]);
    assert_eq!(
        confirm_origin_default_once(&base)
            .await
            .ok()
            .unwrap()
            .history_rewritten,
        None
    );
    run_git(&base, &["update-ref", "-d", "refs/remotes/origin/trunk"]);
    assert_eq!(
        confirm_origin_default_once(&base)
            .await
            .ok()
            .unwrap()
            .history_rewritten,
        None
    );
    cleanup_test_dirs(&[&base, &remote, &path]);
}

#[tokio::test]
async fn retained_baseline_uses_recorded_base_preserves_work_and_warns_once() {
    if !git_available() {
        return;
    }
    let identity = "https://github.com/acme/baseline-retained";
    let (base, remote) = setup_base_with_local_fetch(identity);
    let pools = unique_temp("evidence");
    let layout = layout_for(identity, &pools);
    let request = req("baseline");
    let lease = lease_available_or_create_at(&layout, &base, identity, &request)
        .await
        .unwrap();
    let fresh = observe_lease_baseline_at(&layout, &base, &request, &lease, false)
        .await
        .unwrap();
    assert_eq!(fresh.base_oid, rev(&lease.worktree_path, "HEAD"));
    assert!(fresh.confirmed_at.is_some());
    commit_unpushed_work(&lease.worktree_path, "normal-work");
    std::fs::write(lease.worktree_path.join("dirty.txt"), "keep this\n").unwrap();
    let head = rev(&lease.worktree_path, "HEAD");
    let ordinary = observe_lease_baseline_at(&layout, &base, &request, &lease, true)
        .await
        .unwrap();
    assert_eq!(ordinary.relationship, Some(BaseRelationship::Ancestor));
    assert!(!ordinary.warn_agent);

    // A new root has the same tree; the recorded base is outside its history.
    let output = git_cmd()
        .arg("-C")
        .arg(&remote)
        .args([
            "-c",
            "user.name=Test",
            "-c",
            "user.email=t@t",
            "commit-tree",
            &format!("{}^{{tree}}", fresh.base_oid),
            "-m",
            "replacement root",
        ])
        .output()
        .unwrap();
    assert!(output.status.success());
    let root = String::from_utf8_lossy(&output.stdout).trim().to_string();
    run_git(&remote, &["update-ref", "refs/heads/main", &root]);
    let divergent = observe_lease_baseline_at(&layout, &base, &request, &lease, true)
        .await
        .unwrap();
    assert_eq!(divergent.relationship, Some(BaseRelationship::Diverged));
    assert!(divergent.warn_agent);
    assert!(divergent.notice_key.is_some());
    // A failed spawn did not consume the prompt.
    assert!(
        observe_lease_baseline_at(&layout, &base, &request, &lease, true)
            .await
            .unwrap()
            .warn_agent
    );
    acknowledge_baseline_warning_at(&layout, &request)
        .await
        .unwrap();
    mark_retained_at(&layout, &request).await.unwrap();
    let retained = retained_binding_for_session_at(&layout, &request.session_key)
        .await
        .unwrap();
    let replacement = LeaseRequest {
        run_id: "run-later".into(),
        execution_key: "exec-later".into(),
        ..request
    };
    let resumed = rebind_retained_lease_at(&layout, &base, &retained.authority, &replacement)
        .await
        .unwrap();
    let later = observe_lease_baseline_at(&layout, &base, &replacement, &resumed, true)
        .await
        .unwrap();
    assert!(!later.warn_agent);
    assert_eq!(later.notice_key, divergent.notice_key);
    assert_eq!(later.confirmed_at, fresh.confirmed_at);
    assert_eq!(rev(&resumed.worktree_path, "HEAD"), head);
    assert_eq!(
        std::fs::read_to_string(resumed.worktree_path.join("dirty.txt")).unwrap(),
        "keep this\n"
    );

    run_git(&remote, &["symbolic-ref", "HEAD", "refs/heads/missing"]);
    let unknown = observe_lease_baseline_at(&layout, &base, &replacement, &resumed, true)
        .await
        .unwrap();
    assert_eq!(unknown.relationship, Some(BaseRelationship::Unknown));
    assert!(unknown.notice_key.is_none() && !unknown.warn_agent);
    assert_eq!(rev(&resumed.worktree_path, "HEAD"), head);
    cleanup_test_dirs(&[&base, &remote, &pools]);
}

#[tokio::test]
async fn ancestry_missing_objects_and_shallow_history_are_unknown() {
    if !git_available() {
        return;
    }
    let (base, remote) = setup_base_with_local_fetch("https://github.com/acme/baseline-unknown");
    let oid = rev(&base, "HEAD");
    assert_eq!(proven_ancestor(&base, &oid, &oid).await, Some(true));
    assert_eq!(proven_ancestor(&base, &"0".repeat(40), &oid).await, None);
    let shallow = unique_temp("shallow");
    run_git(
        &shallow,
        &[
            "clone",
            "--quiet",
            "--depth",
            "1",
            &format!("file://{}", remote.display()),
            ".",
        ],
    );
    assert_eq!(proven_ancestor(&shallow, &oid, &oid).await, None);
    cleanup_test_dirs(&[&base, &remote, &shallow]);
}
