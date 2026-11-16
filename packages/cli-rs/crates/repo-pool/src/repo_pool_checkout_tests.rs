    #[tokio::test]
    async fn an_agent_checkout_is_held_retained_and_taken_back_by_its_session() {
        if !git_available() {
            return;
        }
        let identity_url = "https://github.com/acme/checkout.git";
        let (base, remote) = setup_base_with_local_fetch(identity_url);
        let pools = unique_temp("co");
        let layout = layout_for(identity_url, &pools);

        let first = checkout_for_session_at(&layout, &base, identity_url, &req("co1"))
            .await
            .unwrap();
        assert_eq!(first.outcome, CheckoutOutcome::Created);
        let manifest = load_manifest_at(layout.pool_root()).unwrap().unwrap();
        assert_eq!(manifest.slots.get(first.slot_id.as_str()).unwrap().state, SlotState::Leased);

        // Asking again answers with the slot the Run already holds.
        let again = checkout_for_session_at(&layout, &base, identity_url, &req("co1"))
            .await
            .unwrap();
        assert_eq!(again.outcome, CheckoutOutcome::Held);
        assert_eq!(again.worktree_path, first.worktree_path);

        // A live session claims its checkout although it is neither a launch
        // slot nor a cwd.
        let live = PoolLiveness {
            sessions: ["co1".to_string()].into_iter().collect(),
            ..PoolLiveness::default()
        };
        assert!(live.claims_in(&manifest, first.slot_id.as_str(), &first.worktree_path));
        assert!(!PoolLiveness::default().claims_in(&manifest, first.slot_id.as_str(), &first.worktree_path));

        let found = bindings_where_at(&pools, |held| held.session_key == "co1").await;
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].1.slot_id, first.slot_id.as_str());
        assert!(bindings_where_at(&pools, |held| held.session_key == "other").await.is_empty());

        // Natural exit retains; the session's next Run takes the same tree back.
        assert!(retain_exited_at(&layout, &req("co1")).await.unwrap());
        let next = LeaseRequest {
            session_key: "co1".into(),
            instance_id: "inst-co1".into(),
            run_id: "run-co1-b".into(),
            execution_key: "exec-co1-b".into(),
        };
        let reborn = checkout_for_session_at(&layout, &base, identity_url, &next).await.unwrap();
        assert_eq!(reborn.outcome, CheckoutOutcome::Reborn);
        assert_eq!(reborn.worktree_path, first.worktree_path);
        let manifest = load_manifest_at(layout.pool_root()).unwrap().unwrap();
        assert_eq!(manifest.slots.get(first.slot_id.as_str()).unwrap().state, SlotState::Leased);
        assert_eq!(manifest.bindings.len(), 1);
        assert_eq!(manifest.bindings[0].run_id, "run-co1-b");

        // Another session gets its own tree.
        let other = checkout_for_session_at(&layout, &base, identity_url, &req("co2"))
            .await
            .unwrap();
        assert_ne!(other.worktree_path, first.worktree_path);
        cleanup_test_dirs(&[&base, &remote, &pools]);
    }
