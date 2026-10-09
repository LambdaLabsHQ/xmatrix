// --- tests ---

#[cfg(test)]
#[expect(
    clippy::await_holding_lock,
    reason = "each #[tokio::test] runs on its own thread; the guard only serializes process-global env across test threads"
)]
mod tests {
    use super::*;
    include!("../../core/tests/support/fs_cleanup.rs");
    include!("repo_pool_baseline_tests.rs");

    #[test]
    fn default_pool_root_tracks_the_local_config_root() {
        let _guard = crate::test_process_env_lock();
        let config_root = unique_temp("cfg");
        let previous = std::env::var_os("XMATRIX_CONFIG_DIR");
        // This test owns the crate's process-wide env lock.
        unsafe { std::env::set_var("XMATRIX_CONFIG_DIR", &config_root) };
        let pool_root = default_repo_pools_root().expect("pool root");
        match previous {
            Some(value) => unsafe { std::env::set_var("XMATRIX_CONFIG_DIR", value) },
            None => unsafe { std::env::remove_var("XMATRIX_CONFIG_DIR") },
        }
        assert_eq!(pool_root, config_root.join("repo-pools"));
        let _ = std::fs::remove_dir_all(config_root);
    }

    fn unique_temp(label: &str) -> PathBuf {
        let id = uuid::Uuid::new_v4().simple().to_string();
        let root = if cfg!(windows) {
            PathBuf::from(r"C:\xmt")
        } else {
            std::env::temp_dir().join("xmt")
        };
        let dir = root.join(format!(
            "{}-{}",
            label.chars().take(3).collect::<String>(),
            &id[..8]
        ));
        std::fs::create_dir_all(&dir).unwrap();
        // Prefer absolute without Windows \\?\ prefix (git remotes reject it).
        let abs = std::fs::canonicalize(&dir).unwrap_or(dir);
        let s = abs.to_string_lossy();
        if let Some(stripped) = s.strip_prefix(r"\\?\") {
            PathBuf::from(stripped)
        } else {
            abs
        }
    }

    fn git_available() -> bool {
        std::process::Command::new("git")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    fn git_cmd() -> std::process::Command {
        let mut c = std::process::Command::new("git");
        c.env_remove("GIT_DIR")
            .env_remove("GIT_INDEX_FILE")
            .env_remove("GIT_WORK_TREE")
            .env_remove("GIT_OBJECT_DIRECTORY")
            .env_remove("GIT_ALTERNATE_OBJECT_DIRECTORIES");
        c
    }

    fn run_git(cwd: &Path, args: &[&str]) {
        let status = git_cmd().arg("-C").arg(cwd).args(args).status().unwrap();
        assert!(status.success(), "git {args:?} in {}", cwd.display());
    }

    fn setup_base_with_local_fetch(identity_url: &str) -> (PathBuf, PathBuf) {
        let remote = unique_temp("br");
        let seed = unique_temp("sd");
        let base = unique_temp("bs");
        run_git(&seed, &["init", "--quiet", "--initial-branch=main"]);
        std::fs::write(seed.join("README.md"), "v1\n").unwrap();
        std::fs::write(seed.join(".gitignore"), "node_modules/\n.env\n").unwrap();
        run_git(&seed, &["add", "."]);
        run_git(
            &seed,
            &[
                "-c",
                "user.email=test@example.com",
                "-c",
                "user.name=Test",
                "commit",
                "--quiet",
                "-m",
                "init",
            ],
        );
        let remote_url = remote.display().to_string();
        let file_url = format!("file://{}", remote_url.replace('\\', "/"));
        // Seed a real bare remote directly from the real commit; a separate
        // empty remote, origin configuration, and push produce the same history.
        run_git(&seed, &["clone", "--bare", "--quiet", ".", &remote_url]);
        let status = git_cmd()
            .args([
                "clone",
                "--quiet",
                "-c",
                "user.email=test@example.com",
                "-c",
                "user.name=Test",
                &remote_url,
                &base.display().to_string(),
            ])
            .status()
            .unwrap();
        assert!(status.success());
        run_git(&base, &["remote", "set-url", "origin", identity_url]);
        run_git(
            &base,
            &["config", &format!("url.{file_url}.insteadOf"), identity_url],
        );
        // Clone already created origin/main at the seeded HEAD.
        let _ = std::fs::remove_dir_all(&seed);
        (base, remote)
    }

    fn layout_for(identity_url: &str, pools: &Path) -> RepoPoolLayout {
        let identity = canonical_repo_identity(identity_url).unwrap();
        // Ensure pool root exists before first lease (trusted absolute).
        std::fs::create_dir_all(pools).unwrap();
        let pools = if pools.is_absolute() {
            pools.to_path_buf()
        } else {
            std::env::current_dir().unwrap().join(pools)
        };
        RepoPoolLayout::create(&pools, repo_key_id(&identity)).unwrap()
    }

    fn req(session: &str) -> LeaseRequest {
        LeaseRequest {
            session_key: session.to_string(),
            instance_id: format!("inst-{session}"),
            run_id: format!("run-{session}"),
            execution_key: format!("exec-{session}"),
        }
    }

    async fn replace_with_foreign_worktree(base: &Path, foreign_base: &Path, path: &Path) {
        let path_arg = path.display().to_string();
        let _ = git(base, &["worktree", "unlock", &path_arg], GIT_LOCAL_TIMEOUT).await;
        let _ = git(
            base,
            &["worktree", "remove", "--force", &path_arg],
            GIT_MUTATION_TIMEOUT,
        )
        .await;
        let foreign_oid = git(foreign_base, &["rev-parse", "HEAD"], GIT_LOCAL_TIMEOUT)
            .await
            .unwrap();
        git(
            foreign_base,
            &["worktree", "add", "--detach", &path_arg, &foreign_oid],
            GIT_WORKTREE_ADD_TIMEOUT,
        )
        .await
        .unwrap();
    }

    #[cfg(windows)]
    fn create_junction(link: &Path, target: &Path) -> bool {
        std::process::Command::new("cmd")
            .args([
                "/C",
                "mklink",
                "/J",
                &link.display().to_string(),
                &target.display().to_string(),
            ])
            .status()
            .unwrap()
            .success()
    }

    fn quarantined_manifest(
        layout: &RepoPoolLayout,
        slot_id: &SlotId,
        expected_code: PoolErrorCode,
    ) -> RepoPoolManifest {
        let manifest = load_manifest_at(layout.pool_root()).unwrap().unwrap();
        let slot = manifest.slots.get(slot_id.as_str()).unwrap();
        assert_eq!(slot.state, SlotState::Quarantined);
        assert_eq!(slot.quarantine_code, Some(expected_code));
        manifest
    }

    fn commit_unpushed_work(tree: &Path, branch: &str) {
        run_git(tree, &["checkout", "--quiet", "-b", branch]);
        run_git(tree, &["config", "user.email", "test@example.com"]);
        run_git(tree, &["config", "user.name", "Test"]);
        std::fs::write(tree.join("landed.txt"), "committed\n").unwrap();
        run_git(tree, &["add", "landed.txt"]);
        run_git(tree, &["commit", "--quiet", "-m", "unpushed work"]);
    }

    async fn assert_pool_tree_owned(layout: &RepoPoolLayout, base: &Path, lease: &LeaseResult) {
        verify_pool_worktree_ownership(layout, base, &lease.worktree_path, &lease.slot_id)
            .await
            .unwrap();
    }

    fn assert_evicted_tree(outcome: &PoolReclaimOutcome, slot: &str, tree: &Path) {
        assert_eq!(outcome.evicted, vec![slot.to_string()]);
        assert!(!tree.exists());
    }

    async fn rehydrate_at_original_path(
        layout: &RepoPoolLayout,
        base: &Path,
        record: &RehydrateRecord,
        tree: &Path,
    ) {
        let woken = rehydrate_retained_lease_at(layout, base, record, &replacement_for(record))
            .await
            .unwrap();
        assert_eq!(woken.worktree_path, tree);
        assert_eq!(current_branch(tree), "feat/lost");
    }

    fn authority_for(request: &LeaseRequest, slot_id: &SlotId) -> BindingAuthority {
        BindingRecord::for_lease(slot_id, request).authority()
    }

    fn empty_manifest(identity: &CanonicalRepoIdentity, version: u8) -> RepoPoolManifest {
        RepoPoolManifest {
            version,
            canonical_repo_identity: identity.as_str().into(),
            repo_key_id: repo_key_id(identity).as_str().into(),
            base_repo_path: None,
            slots: BTreeMap::new(),
            bindings: Vec::new(),
        }
    }

    fn state_of(layout: &RepoPoolLayout, slot_id: &str) -> SlotState {
        load_manifest_at(layout.pool_root())
            .unwrap()
            .unwrap()
            .slots
            .get(slot_id)
            .expect("slot record")
            .state
    }

    #[test]
    fn compact_pool_paths_preserve_full_authority_and_resume() {
        let pools = unique_temp("cmp");
        let layout = layout_for("acme/widget", &pools);
        assert_eq!(layout.pool_root().file_name().unwrap().len(), 8);
        let slot = SlotId::generate();
        let legacy_path = pools
            .join(layout.repo_key().as_str())
            .join(SLOTS_DIR)
            .join(slot.as_str());
        assert_eq!(
            legacy_path.as_os_str().len() - layout.slot_path(&slot).unwrap().as_os_str().len(),
            88
        );
        assert_eq!(
            layout.slot_path(&slot).unwrap().file_name().unwrap().len(),
            6
        );
        assert!(!layout.pool_root().join(SLOTS_DIR).exists());
        let resumed = RepoPoolLayout::from_persisted(&pools, layout.repo_key().as_str()).unwrap();
        assert_eq!(
            resumed.slot_path(&slot).unwrap(),
            layout.slot_path(&slot).unwrap()
        );
        resumed.revalidate_on_disk().unwrap();
        let _ = std::fs::remove_dir_all(pools);
    }

    #[test]
    fn legacy_pool_paths_are_reused_without_moving_slots() {
        let pools = unique_temp("leg");
        let key = repo_key_id(&canonical_repo_identity("acme/widget").unwrap());
        let legacy = pools.join(key.as_str());
        std::fs::create_dir_all(legacy.join(SLOTS_DIR)).unwrap();
        let layout = RepoPoolLayout::from_persisted(&pools, key.as_str()).unwrap();
        assert_eq!(layout.pool_root(), legacy);
        layout.revalidate_on_disk().unwrap();
        assert!(!pools.join(&key.as_str()[..POOL_DIR_KEY_CHARS]).exists());
        let _ = std::fs::remove_dir_all(pools);
    }

    #[test]
    fn compact_pool_collision_fails_before_manifest_exists() {
        let pools = unique_temp("col");
        let first = format!("{}{}", "a".repeat(8), "b".repeat(56));
        let second = format!("{}{}", "a".repeat(8), "c".repeat(56));
        let layout = RepoPoolLayout::from_persisted(&pools, &first).unwrap();
        let error = RepoPoolLayout::from_persisted(&pools, &second).unwrap_err();
        assert_eq!(error.code, PoolErrorCode::ManifestMismatch);
        assert!(!layout.pool_root().join(MANIFEST_FILE).exists());
        layout.revalidate_on_disk().unwrap();
        let _ = std::fs::remove_dir_all(pools);
    }

    #[test]
    fn compact_pool_partial_or_replaced_claim_fails_closed() {
        let pools = unique_temp("clm");
        let layout = layout_for("acme/widget", &pools);
        for value in ["", &"f".repeat(64)] {
            std::fs::write(layout.pool_root().join(POOL_KEY_FILE), value).unwrap();
            assert_eq!(
                layout.revalidate_on_disk().unwrap_err().code,
                PoolErrorCode::ManifestMismatch
            );
            assert_eq!(
                RepoPoolLayout::from_persisted(&pools, layout.repo_key().as_str())
                    .unwrap_err()
                    .code,
                PoolErrorCode::ManifestMismatch
            );
        }
        let _ = std::fs::remove_dir_all(pools);
    }

    #[test]
    fn compact_pool_concurrent_claims_agree_on_full_key() {
        let pools = unique_temp("ccm");
        let key = repo_key_id(&canonical_repo_identity("acme/widget").unwrap());
        let barrier = std::sync::Barrier::new(8);
        std::thread::scope(|scope| {
            for _ in 0..8 {
                scope.spawn(|| {
                    barrier.wait();
                    claim_compact_pool(&pools, &key).unwrap();
                });
            }
        });
        validate_compact_pool_key(&pools, &key).unwrap();
        let _ = std::fs::remove_dir_all(pools);
    }

    #[test]
    fn compact_slot_collisions_are_retried_and_corrupt_aliases_rejected() {
        let pools = unique_temp("alc");
        let identity = canonical_repo_identity("acme/widget").unwrap();
        let layout = layout_for(identity.as_str(), &pools);
        let mut manifest = empty_manifest(&identity, COMPACT_MANIFEST_VERSION);
        let first = SlotId::parse(&format!("aaaaaa{}", "1".repeat(26))).unwrap();
        let collision = SlotId::parse(&format!("aaaaaa{}", "2".repeat(26))).unwrap();
        let unrecorded = SlotId::parse(&format!("bbbbbb{}", "3".repeat(26))).unwrap();
        let fresh = SlotId::parse(&format!("cccccc{}", "4".repeat(26))).unwrap();
        let record = SlotRecord {
            slot_id: first.as_str().into(),
            state: SlotState::Quarantined,
            last_base_ref: None,
            last_base_oid: None,
            updated_at: now_rfc3339(),
            quarantine_code: Some(PoolErrorCode::VerifyFailed),
            spawn_claim_token: None,
            last_returned_binding: None,
        };
        manifest.slots.insert(first.as_str().into(), record.clone());
        std::fs::create_dir(layout.slot_path(&unrecorded).unwrap()).unwrap();
        let mut candidates = [collision.clone(), unrecorded, fresh.clone()].into_iter();
        assert_eq!(
            allocate_slot_id(&layout, &manifest, || candidates.next().unwrap()).unwrap(),
            fresh
        );
        assert_eq!(
            allocate_slot_id(&layout, &manifest, || collision.clone())
                .unwrap_err()
                .code,
            PoolErrorCode::WorktreeCreateFailed
        );
        validate_manifest(&manifest).unwrap();
        manifest.slots.insert(
            collision.as_str().into(),
            SlotRecord {
                slot_id: collision.as_str().into(),
                ..record
            },
        );
        assert_eq!(
            validate_manifest(&manifest).unwrap_err().code,
            PoolErrorCode::ManifestCorrupt
        );
        manifest.version = MANIFEST_VERSION;
        validate_manifest(&manifest).unwrap(); // Full names remain distinct in legacy pools.
        assert_eq!(
            validate_manifest_matches_layout(&manifest, &layout)
                .unwrap_err()
                .code,
            PoolErrorCode::ManifestMismatch
        );
        let _ = std::fs::remove_dir_all(pools);
    }

    async fn assert_missing_checkout_pruned(pools: &Path, checkout: &Path, slot: &str) {
        std::fs::remove_dir_all(checkout).unwrap();
        let outcome = reclaim_pool_slots_at(pools, &PoolLiveness::default(), 8).await;
        assert_eq!(outcome.pruned, vec![slot.to_string()]);
    }

    #[tokio::test]
    async fn legacy_pool_lease_and_retry_keep_full_slot_path_and_v1_manifest() {
        if !git_available() {
            return;
        }
        let identity_url = "https://github.com/acme/legacy-path.git";
        let (base, remote) = setup_base_with_local_fetch(identity_url);
        let pools = unique_temp("lcy");
        let key = repo_key_id(&canonical_repo_identity(identity_url).unwrap());
        std::fs::create_dir_all(pools.join(key.as_str())).unwrap();
        let layout = layout_for(identity_url, &pools);
        let request = req("legacy");
        let lease = lease_available_or_create_at(&layout, &base, identity_url, &request)
            .await
            .unwrap();
        let expected = pools
            .join(key.as_str())
            .join(SLOTS_DIR)
            .join(lease.slot_id.as_str());
        assert_eq!(lease.worktree_path, expected);
        assert_eq!(
            load_manifest_at(layout.pool_root())
                .unwrap()
                .unwrap()
                .version,
            MANIFEST_VERSION
        );
        let retry = lease_available_or_create_at(&layout, &base, identity_url, &request)
            .await
            .unwrap();
        assert_eq!(retry.worktree_path, expected);
        assert_pool_tree_owned(&layout, &base, &retry).await;
        let _ = std::fs::remove_dir_all(pools);
        let _ = std::fs::remove_dir_all(base);
        let _ = std::fs::remove_dir_all(remote);
    }

    #[test]
    fn k1_token_url_and_clean_url_same_key() {
        let a = canonical_repo_identity("https://user:token@github.com/Acme/Widget.git?foo=1#frag")
            .unwrap();
        let b = canonical_repo_identity("https://github.com/acme/widget").unwrap();
        assert_eq!(a.as_str(), b.as_str());
        assert!(!a.as_str().contains("token"));
        assert!(!a.as_str().contains('?'));
    }

    #[test]
    fn identity_rejects_github_extra_path_and_query_variants() {
        assert!(canonical_repo_identity("https://github.com/a/b/extra").is_err());
        assert!(canonical_repo_identity("git@github.com:a/b/extra.git").is_err());
        assert!(
            canonical_repo_identity("git@gitlab.example.com:Group/Repo.git?tenant=A").is_err(),
            "scp-like ? is a path byte, not URL query syntax; reject rather than collide"
        );
        assert!(
            canonical_repo_identity("gitlab.example.com/Group/Repo#tenant-A").is_err(),
            "host shorthand # is ambiguous and must fail closed"
        );
        assert!(canonical_repo_identity(r"C:\repo").is_err());
        assert!(canonical_repo_identity("file:///tmp/r").is_err());
    }

    #[test]
    fn k2_owner_repo_https_ssh_equivalent() {
        let a = canonical_repo_identity("Acme/Widget").unwrap();
        let b = canonical_repo_identity("https://github.com/Acme/Widget.git").unwrap();
        let c = canonical_repo_identity("git@github.com:Acme/Widget.git").unwrap();
        assert_eq!(a, b);
        assert_eq!(b, c);
    }

    #[test]
    fn k3_identity_preserves_meaningful_repo_and_host_distinctions() {
        let clean = canonical_repo_identity("https://gitlab.example/Group/Repo.git").unwrap();
        let raw_at_password =
            canonical_repo_identity("https://user:pa@ss@gitlab.example/Group/Repo.git?token=x#f")
                .unwrap();
        assert_eq!(raw_at_password, clean);
        assert!(!raw_at_password.as_str().contains("user"));
        assert!(!raw_at_password.as_str().contains("pa@ss"));

        let repo = canonical_repo_identity("https://github.com/acme/repo.git").unwrap();
        let repo_named_dot_git =
            canonical_repo_identity("https://github.com/acme/repo.git.git").unwrap();
        assert_ne!(repo, repo_named_dot_git, "strip at most one .git suffix");
        assert_eq!(repo_named_dot_git.as_str(), "github.com/acme/repo.git");

        let github = canonical_repo_identity("https://github.com/acme/repo").unwrap();
        let github_default =
            canonical_repo_identity("https://github.com:443/acme/repo.git").unwrap();
        let github_nondefault =
            canonical_repo_identity("https://github.com:8443/acme/repo.git").unwrap();
        assert_eq!(github, github_default);
        assert_ne!(github, github_nondefault);
        assert!(github_nondefault.as_str().contains(":8443/"));
        assert_eq!(
            canonical_repo_identity(github_nondefault.as_str()).unwrap(),
            github_nondefault,
            "canonical non-default-port identity must be idempotent"
        );

        let case_a = canonical_repo_identity("https://gitlab.example/Group/Repo.git").unwrap();
        let case_b = canonical_repo_identity("https://gitlab.example/group/Repo.git").unwrap();
        let port = canonical_repo_identity("https://gitlab.example:8443/Group/Repo.git").unwrap();
        assert_ne!(case_a, case_b, "non-GitHub path case is identity");
        assert_ne!(case_a, port, "explicit non-default port is identity");
        assert_eq!(canonical_repo_identity(port.as_str()).unwrap(), port);

        let ssh_port = canonical_repo_identity("ssh://gitlab.example:2222/Org/Repo.git").unwrap();
        let scp_numeric_path = canonical_repo_identity("gitlab.example:2222/Org/Repo.git").unwrap();
        let scp_numeric_path_with_user =
            canonical_repo_identity("git@gitlab.example:2222/Org/Repo.git").unwrap();
        assert_ne!(
            ssh_port, scp_numeric_path,
            "URL port and scp numeric path segment are different repo identities"
        );
        assert_eq!(scp_numeric_path, scp_numeric_path_with_user);
        assert!(ssh_port.as_str().starts_with("ssh://"));
        assert_eq!(
            canonical_repo_identity(ssh_port.as_str()).unwrap(),
            ssh_port
        );

        let ipv6 = canonical_repo_identity("ssh://[::1]/Org/Repo.git").unwrap();
        let ipv6_port = canonical_repo_identity("ssh://[::1]:2222/Org/Repo.git").unwrap();
        let ipv6_scp = canonical_repo_identity("git@[::1]:Org/Repo.git").unwrap();
        let ipv6_scp_without_user = canonical_repo_identity("[::1]:Org/Repo.git").unwrap();
        assert_eq!(canonical_repo_identity(ipv6.as_str()).unwrap(), ipv6);
        assert_eq!(
            canonical_repo_identity(ipv6_port.as_str()).unwrap(),
            ipv6_port
        );
        assert_eq!(ipv6_scp, ipv6_scp_without_user);
        assert_eq!(
            canonical_repo_identity(ipv6_scp.as_str()).unwrap(),
            ipv6_scp
        );
        assert_ne!(ipv6_port, ipv6_scp);
        assert!(!ipv6.as_str().contains("[["));
        assert!(!ipv6_port.as_str().contains("[["));

        let short_ssh = canonical_repo_identity("ssh://gitbox/Org/Repo.git").unwrap();
        let short_scp = canonical_repo_identity("gitbox:Org/Repo.git").unwrap();
        let short_scp_one_segment = canonical_repo_identity("gitbox:Repo.git").unwrap();
        let short_https = canonical_repo_identity("https://gitbox/Org/Repo.git").unwrap();
        assert_eq!(short_ssh, short_scp);
        assert!(short_ssh.as_str().starts_with("ssh://gitbox/"));
        assert!(short_scp_one_segment.as_str().starts_with("ssh://gitbox/"));
        assert!(short_https.as_str().starts_with("https://gitbox/"));
        for identity in [&short_ssh, &short_scp_one_segment, &short_https] {
            assert_eq!(
                canonical_repo_identity(identity.as_str()).unwrap(),
                *identity
            );
            assert!(!identity.as_str().starts_with("github.com/"));
        }
        assert_ne!(short_ssh, short_https);
        assert_ne!(
            short_scp_one_segment,
            canonical_repo_identity("gitbox/Repo").unwrap(),
            "dotless scp host must not become GitHub owner/repo shorthand"
        );

        let unicode_scp = canonical_repo_identity("git@bücher.example:Org/Repo.git").unwrap();
        let punycode_scp =
            canonical_repo_identity("git@xn--bcher-kva.example:Org/Repo.git").unwrap();
        assert_eq!(unicode_scp, punycode_scp);
        assert!(unicode_scp.as_str().starts_with("xn--bcher-kva.example/"));
        assert_eq!(
            canonical_repo_identity(unicode_scp.as_str()).unwrap(),
            unicode_scp
        );
    }

    #[test]
    fn k4_full_hash_avoids_safe_character_replacement_collisions() {
        let dash = canonical_repo_identity("gitlab.example/acme/a-b").unwrap();
        let underscore = canonical_repo_identity("gitlab.example/acme/a_b").unwrap();
        assert_ne!(dash, underscore);
        assert_ne!(repo_key_id(&dash), repo_key_id(&underscore));
        assert_eq!(repo_key_id(&dash).as_str().len(), 64);
    }

    #[test]
    fn uppercase_repo_key_rejected_on_load() {
        let root = unique_temp("up");
        let identity = canonical_repo_identity("github.com/acme/w").unwrap();
        let mut m = empty_manifest(&identity, 1);
        m.repo_key_id.make_ascii_uppercase();
        std::fs::write(root.join(MANIFEST_FILE), serde_json::to_vec(&m).unwrap()).unwrap();
        assert!(load_manifest_at(&root).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn manifest_schema_rejects_unknown_fields_at_every_level() {
        let identity = canonical_repo_identity("github.com/acme/schema").unwrap();
        let manifest = empty_manifest(&identity, MANIFEST_VERSION);
        let mut value = serde_json::to_value(&manifest).unwrap();
        value
            .as_object_mut()
            .unwrap()
            .insert("futureAuthority".into(), serde_json::json!(true));
        assert!(serde_json::from_value::<RepoPoolManifest>(value).is_err());

        let slot = SlotRecord {
            slot_id: SlotId::generate().as_str().into(),
            state: SlotState::Available,
            last_base_ref: Some("origin/main".into()),
            last_base_oid: Some("0".repeat(40)),
            updated_at: now_rfc3339(),
            quarantine_code: None,
            spawn_claim_token: None,
            last_returned_binding: None,
        };
        let mut slot_value = serde_json::to_value(&slot).unwrap();
        slot_value
            .as_object_mut()
            .unwrap()
            .insert("worktreePath".into(), serde_json::json!("outside"));
        assert!(serde_json::from_value::<SlotRecord>(slot_value).is_err());

        let binding = BindingRecord {
            session_key: "s".into(),
            instance_id: "i".into(),
            run_id: "r".into(),
            execution_key: "e".into(),
            slot_id: SlotId::generate().as_str().into(),
        };
        let mut binding_value = serde_json::to_value(&binding).unwrap();
        binding_value
            .as_object_mut()
            .unwrap()
            .insert("repoKey".into(), serde_json::json!("wrong-layer"));
        assert!(serde_json::from_value::<BindingRecord>(binding_value).is_err());
    }

    #[test]
    fn layout_rejects_relative_pools_root() {
        let key = repo_key_id(&canonical_repo_identity("github.com/a/b").unwrap());
        assert!(RepoPoolLayout::create(Path::new("relative/pools"), key).is_err());
    }

    #[test]
    fn stale_temp_does_not_override_manifest() {
        let root = unique_temp("tmp");
        let identity = canonical_repo_identity("github.com/acme/w").unwrap();
        let m = empty_manifest(&identity, 1);
        save_manifest_at(&root, &m).unwrap();
        std::fs::write(root.join("pool.json.stale.tmp"), b"not-json").unwrap();
        let loaded = load_manifest_at(&root).unwrap().unwrap();
        assert_eq!(loaded.repo_key_id, m.repo_key_id);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(windows)]
    #[test]
    fn windows_junction_on_slots_component_rejected() {
        let trusted = unique_temp("jn");
        let outside = unique_temp("jout");
        std::fs::write(outside.join("secret"), "x").unwrap();
        let key = repo_key_id(&canonical_repo_identity("github.com/a/b").unwrap());
        std::fs::create_dir_all(trusted.join(key.as_str())).unwrap();
        let layout = RepoPoolLayout::create(&trusted, key.clone()).unwrap();
        let slots = layout.pool_root().join(SLOTS_DIR);
        let _ = std::fs::remove_dir_all(&slots);
        if !create_junction(&slots, &outside) {
            cleanup_test_dirs(&[&trusted, &outside]);
            return;
        }
        let slot = SlotId::generate();
        let evil = slots.join(slot.as_str());
        assert!(ensure_path_inside_layout(&layout, &evil).is_err());
        cleanup_test_dirs(&[&trusted, &outside]);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_junction_on_pool_root_blocks_lease() {
        if !git_available() {
            return;
        }
        let identity_url = "https://github.com/acme/junc-pool.git";
        let (base, remote) = setup_base_with_local_fetch(identity_url);
        let trusted = unique_temp("jp");
        let outside = unique_temp("jpout");
        let layout = layout_for(identity_url, &trusted);
        let pool_root = layout.pool_root().to_path_buf();
        // Replace repo/pool_root component with junction to outside.
        let _ = std::fs::remove_dir_all(&pool_root);
        if !create_junction(&pool_root, &outside) {
            cleanup_test_dirs(&[&trusted, &outside, &base, &remote]);
            return;
        }
        let err = lease_available_or_create_at(&layout, &base, identity_url, &req("j1"))
            .await
            .unwrap_err();
        assert_eq!(err.code, PoolErrorCode::PathEscape);
        assert!(
            !outside.join(MANIFEST_FILE).exists(),
            "pool.json must not be created outside the trusted root"
        );
        // Direct revalidation must also fail.
        assert_eq!(
            layout.revalidate_on_disk().unwrap_err().code,
            PoolErrorCode::PathEscape
        );
        cleanup_test_dirs(&[&trusted, &outside, &base, &remote]);
    }

    #[cfg(unix)]
    #[test]
    fn symlink_escape_under_trusted_root_rejected() {
        let trusted = unique_temp("sy");
        let outside = unique_temp("out");
        std::fs::write(outside.join("secret"), "x").unwrap();
        let key = repo_key_id(&canonical_repo_identity("github.com/a/b").unwrap());
        let layout = RepoPoolLayout::create(&trusted, key).unwrap();
        let slot = SlotId::generate();
        let evil = layout.slot_path(&slot).unwrap();
        std::os::unix::fs::symlink(&outside, &evil).unwrap();
        assert!(ensure_path_inside_layout(&layout, &evil).is_err());
        cleanup_test_dirs(&[&trusted, &outside]);
    }

    #[tokio::test]
    async fn intermediate_persisted_before_same_session_early_return() {
        if !git_available() {
            return;
        }
        let identity_url = "https://github.com/acme/inter.git";
        let (base, remote) = setup_base_with_local_fetch(identity_url);
        let pools = unique_temp("ir");
        let layout = layout_for(identity_url, &pools);
        let lease = lease_available_or_create_at(&layout, &base, identity_url, &req("i1"))
            .await
            .unwrap();
        let mut m = load_manifest_at(layout.pool_root()).unwrap().unwrap();
        let slot = m.slots.get_mut(lease.slot_id.as_str()).unwrap();
        slot.state = SlotState::Returning;
        slot.quarantine_code = None;
        slot.spawn_claim_token = None;
        save_manifest_at(layout.pool_root(), &m).unwrap();
        // Same session hits "session already bound" AFTER load_for_update persists quarantine.
        let err = lease_available_or_create_at(&layout, &base, identity_url, &req("i1"))
            .await
            .unwrap_err();
        assert_eq!(err.code, PoolErrorCode::InvalidBinding);
        let m2 = load_manifest_at(layout.pool_root()).unwrap().unwrap();
        let slot = m2.slots.get(lease.slot_id.as_str()).unwrap();
        assert_eq!(slot.state, SlotState::Quarantined);
        assert_eq!(slot.quarantine_code, Some(PoolErrorCode::IntermediateCrash));
        assert!(m2.bindings.iter().any(|b| b.session_key == "i1"));
        cleanup_test_dirs(&[&pools, &base, &remote]);
    }

    #[tokio::test]
    async fn swapped_manifest_is_rejected_before_intermediate_reconcile() {
        if !git_available() {
            return;
        }
        let identity_a = "https://github.com/acme/layout-a.git";
        let identity_b = "https://github.com/acme/layout-b.git";
        let (base_a, remote_a) = setup_base_with_local_fetch(identity_a);
        let (base_b, remote_b) = setup_base_with_local_fetch(identity_b);
        let pools = unique_temp("swp");
        let layout_a = layout_for(identity_a, &pools);
        let layout_b = layout_for(identity_b, &pools);
        let _lease_a = lease_available_or_create_at(&layout_a, &base_a, identity_a, &req("swap-a"))
            .await
            .unwrap();
        let lease_b = lease_available_or_create_at(&layout_b, &base_b, identity_b, &req("swap-b"))
            .await
            .unwrap();

        let mut foreign = load_manifest_at(layout_b.pool_root()).unwrap().unwrap();
        let foreign_slot = foreign.slots.get_mut(lease_b.slot_id.as_str()).unwrap();
        foreign_slot.state = SlotState::Returning;
        foreign_slot.spawn_claim_token = None;
        save_manifest_at(layout_b.pool_root(), &foreign).unwrap();
        std::fs::copy(
            layout_b.pool_root().join(MANIFEST_FILE),
            layout_a.pool_root().join(MANIFEST_FILE),
        )
        .unwrap();
        let before = std::fs::read(layout_a.pool_root().join(MANIFEST_FILE)).unwrap();

        let assert_unchanged = || {
            assert_eq!(
                std::fs::read(layout_a.pool_root().join(MANIFEST_FILE)).unwrap(),
                before,
                "layout binding must fail before reconciling/persisting foreign intermediates"
            );
        };
        assert_eq!(
            mark_retained_at(&layout_a, &req("swap-b"))
                .await
                .unwrap_err()
                .code,
            PoolErrorCode::ManifestMismatch
        );
        assert_unchanged();

        let expected = authority_for(&req("swap-b"), &lease_b.slot_id);
        let replacement = LeaseRequest {
            session_key: "swap-b".into(),
            instance_id: "inst-swap-b2".into(),
            run_id: "run-swap-b2".into(),
            execution_key: "exec-swap-b2".into(),
        };
        assert_eq!(
            rebind_retained_lease_at(&layout_a, &base_a, &expected, &replacement)
                .await
                .unwrap_err()
                .code,
            PoolErrorCode::ManifestMismatch
        );
        assert_unchanged();
        assert_eq!(
            return_abandoned_slot_at(&layout_a, &base_a, &req("swap-b"))
                .await
                .unwrap_err()
                .code,
            PoolErrorCode::ManifestMismatch
        );
        assert_unchanged();

        cleanup_test_dirs(&[&pools, &base_a, &remote_a, &base_b, &remote_b]);
    }

    #[tokio::test]
    async fn s1_l1_linked_worktree_lifecycle() {
        if !git_available() {
            return;
        }
        let identity_url = "https://github.com/acme/pool-fixture.git";
        let (base, remote) = setup_base_with_local_fetch(identity_url);
        let pools = unique_temp("pl");
        let layout = layout_for(identity_url, &pools);

        let lease = lease_available_or_create_at(&layout, &base, identity_url, &req("s1"))
            .await
            .expect("lease");
        let lease2 = lease_available_or_create_at(&layout, &base, identity_url, &req("s2"))
            .await
            .expect("lease2");
        let git_dir1 = git(
            &lease.worktree_path,
            &["rev-parse", "--path-format=absolute", "--git-dir"],
            GIT_LOCAL_TIMEOUT,
        )
        .await
        .unwrap();
        let git_dir2 = git(
            &lease2.worktree_path,
            &["rev-parse", "--path-format=absolute", "--git-dir"],
            GIT_LOCAL_TIMEOUT,
        )
        .await
        .unwrap();
        assert_ne!(git_dir1, git_dir2);
        let common1 = git(
            &lease.worktree_path,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
            GIT_LOCAL_TIMEOUT,
        )
        .await
        .unwrap();
        let common2 = git(
            &lease2.worktree_path,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
            GIT_LOCAL_TIMEOUT,
        )
        .await
        .unwrap();
        assert_eq!(common1, common2);

        std::fs::create_dir_all(lease.worktree_path.join("node_modules")).unwrap();
        std::fs::write(lease.worktree_path.join("node_modules/x"), "kept\n").unwrap();
        std::fs::write(lease.worktree_path.join("WIP.txt"), "dirty\n").unwrap();
        mark_retained_at(&layout, &req("s1")).await.unwrap();
        // Pool lock reason is verifiable and contains repo/slot only.
        let reason = read_worktree_lock_reason(&base, &lease.worktree_path)
            .await
            .unwrap()
            .expect("pool worktree lock");
        let expected = pool_worktree_lock_reason(&layout, &lease.slot_id);
        assert_eq!(reason, expected);
        assert!(reason.starts_with(WORKTREE_LOCK_REASON_PREFIX));
        assert!(reason.contains(layout.repo_key().as_str()));
        assert!(reason.contains(lease.slot_id.as_str()));
        assert!(!reason.contains("token"));
        let returned_authority = authority_for(&req("s1"), &lease.slot_id);
        assert!(
            !completed_return_receipt_matches_at(&layout, &returned_authority)
                .await
                .unwrap()
        );
        return_abandoned_slot_at(&layout, &base, &req("s1"))
            .await
            .unwrap();
        assert!(
            completed_return_receipt_matches_at(&layout, &returned_authority)
                .await
                .unwrap()
        );
        return_abandoned_authority_at(&layout, &base, &returned_authority)
            .await
            .expect("exact abandon retry must be idempotent after registry-persist failure");
        return_retained_authority_without_base_at(&layout, &returned_authority)
            .await
            .expect("no-live exact retry must consume the completed return receipt");
        assert!(lease.worktree_path.join("node_modules/x").is_file());
        assert!(!lease.worktree_path.join("WIP.txt").exists());

        let again = lease_available_or_create_at(&layout, &base, identity_url, &req("s4"))
            .await
            .unwrap();
        assert!(again.reused_available);
        return_abandoned_authority_at(&layout, &base, &returned_authority)
            .await
            .expect("late exact retry must not disturb the slot's newer lease");
        let after_late_retry = load_manifest_at(layout.pool_root()).unwrap().unwrap();
        assert!(after_late_retry.bindings.iter().any(|binding| {
            binding.session_key == req("s4").session_key
                && binding.slot_id == again.slot_id.as_str()
        }));
        std::fs::write(again.worktree_path.join("WIP2.txt"), "d\n").unwrap();
        return_abandoned_slot_at(&layout, &base, &req("s4"))
            .await
            .unwrap();
        let refs = git(
            &base,
            &[
                "for-each-ref",
                "--format=%(refname)",
                &format!("refs/xmatrix/snapshot/{}/", again.slot_id.as_str()),
            ],
            GIT_LOCAL_TIMEOUT,
        )
        .await
        .unwrap();
        assert!(
            refs.lines().filter(|l| !l.is_empty()).count() >= 1,
            "snapshot hierarchy under slotId: {refs:?}"
        );

        let retained_only = req("retained-only");
        let retained_only_lease =
            lease_available_or_create_at(&layout, &base, identity_url, &retained_only)
                .await
                .expect("retained-only lease");
        let retained_only_authority = authority_for(&retained_only, &retained_only_lease.slot_id);
        let live_err = return_retained_authority_without_base_at(&layout, &retained_only_authority)
            .await
            .expect_err("no-live return must not treat a leased slot as stopped");
        assert_eq!(live_err.code, PoolErrorCode::InvalidBinding);
        mark_retained_at(&layout, &retained_only)
            .await
            .expect("retain after confirmed stop");
        return_retained_authority_without_base_at(&layout, &retained_only_authority)
            .await
            .expect("retained exact authority may return to the pool");

        cleanup_test_dirs(&[&pools, &base, &remote]);
    }

    #[tokio::test]
    async fn fetch_failure_quarantines_with_binding() {
        if !git_available() {
            return;
        }
        let identity_url = "https://github.com/acme/fetch-fail.git";
        let (base, remote) = setup_base_with_local_fetch(identity_url);
        let pools = unique_temp("ff");
        let layout = layout_for(identity_url, &pools);
        let lease = lease_available_or_create_at(&layout, &base, identity_url, &req("ff1"))
            .await
            .unwrap();
        if let Ok(out) = git_cmd()
            .arg("-C")
            .arg(&base)
            .args(["config", "--get-regexp", r"^url\..*\.insteadof$"])
            .output()
        {
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                if let Some(key) = line.split_whitespace().next() {
                    let _ = git_cmd()
                        .arg("-C")
                        .arg(&base)
                        .args(["config", "--unset-all", key])
                        .status();
                }
            }
        }
        let missing = unique_temp("nope");
        let _ = std::fs::remove_dir_all(&missing);
        let missing_url = format!(
            "file://{}",
            missing.display().to_string().replace('\\', "/")
        );
        run_git(
            &base,
            &[
                "config",
                &format!("url.{missing_url}.insteadOf"),
                identity_url,
            ],
        );
        let err = return_abandoned_slot_at(&layout, &base, &req("ff1"))
            .await
            .unwrap_err();
        assert_eq!(err.code, PoolErrorCode::FetchRequiredFailed);
        let m = quarantined_manifest(&layout, &lease.slot_id, PoolErrorCode::FetchRequiredFailed);
        assert!(m.bindings.iter().any(|b| b.session_key == "ff1"));
        let err2 = return_abandoned_slot_at(&layout, &base, &req("ff1"))
            .await
            .unwrap_err();
        assert_eq!(err2.code, PoolErrorCode::InvalidBinding);
        cleanup_test_dirs(&[&pools, &base, &remote]);
    }

    #[tokio::test]
    async fn snapshot_add_failure_via_index_lock_does_not_reset_wip() {
        if !git_available() {
            return;
        }
        let identity_url = "https://github.com/acme/snapfail.git";
        let (base, remote) = setup_base_with_local_fetch(identity_url);
        let pools = unique_temp("sf");
        let layout = layout_for(identity_url, &pools);
        let lease = lease_available_or_create_at(&layout, &base, identity_url, &req("sf1"))
            .await
            .unwrap();
        let wip = lease.worktree_path.join("KEEP_WIP.txt");
        std::fs::write(&wip, "must-survive\n").unwrap();
        // Force git add failure with a held index.lock (no hooks; --no-verify stays on).
        let git_dir = git(
            &lease.worktree_path,
            &["rev-parse", "--path-format=absolute", "--git-dir"],
            GIT_LOCAL_TIMEOUT,
        )
        .await
        .unwrap();
        let index_lock = PathBuf::from(git_dir.trim()).join("index.lock");
        let _lock_file = std::fs::File::create(&index_lock).unwrap();
        let err = return_abandoned_slot_at(&layout, &base, &req("sf1"))
            .await
            .unwrap_err();
        assert_eq!(err.code, PoolErrorCode::SnapshotCommitFailed);
        assert!(wip.is_file(), "WIP must remain when git add fails");
        assert!(
            std::fs::read_to_string(&wip)
                .unwrap()
                .contains("must-survive")
        );
        let m = load_manifest_at(layout.pool_root()).unwrap().unwrap();
        let slot = m.slots.get(lease.slot_id.as_str()).unwrap();
        assert_eq!(slot.state, SlotState::Quarantined);
        assert!(m.bindings.iter().any(|b| b.session_key == "sf1"));
        drop(_lock_file);
        let _ = std::fs::remove_file(&index_lock);
        cleanup_test_dirs(&[&pools, &base, &remote]);
    }

    #[tokio::test]
    async fn hidden_untracked_config_cannot_bypass_snapshot() {
        if !git_available() {
            return;
        }
        let identity_url = "https://github.com/acme/status-hidden.git";
        let (base, remote) = setup_base_with_local_fetch(identity_url);
        let pools = unique_temp("shu");
        let layout = layout_for(identity_url, &pools);
        let lease = lease_available_or_create_at(&layout, &base, identity_url, &req("shu1"))
            .await
            .unwrap();
        run_git(
            &lease.worktree_path,
            &["config", "status.showUntrackedFiles", "no"],
        );
        let hidden = lease.worktree_path.join("HIDDEN_WIP.txt");
        std::fs::write(&hidden, "must-be-snapshotted\n").unwrap();

        return_abandoned_slot_at(&layout, &base, &req("shu1"))
            .await
            .unwrap();
        assert!(
            !hidden.exists(),
            "fresh available tree removes nonignored WIP"
        );
        let refs = git(
            &base,
            &[
                "for-each-ref",
                "--format=%(objectname)",
                &format!("refs/xmatrix/snapshot/{}/", lease.slot_id.as_str()),
            ],
            GIT_LOCAL_TIMEOUT,
        )
        .await
        .unwrap();
        let snapshot_oid = refs.lines().next().expect("snapshot ref must exist");
        git(
            &base,
            &["cat-file", "-e", &format!("{snapshot_oid}:HIDDEN_WIP.txt")],
            GIT_LOCAL_TIMEOUT,
        )
        .await
        .expect("hidden-by-config WIP must be present in snapshot commit");

        cleanup_test_dirs(&[&pools, &base, &remote]);
    }

    #[tokio::test]
    async fn untracked_nested_repo_quarantines_without_destroying_nested_wip() {
        if !git_available() {
            return;
        }
        let identity_url = "https://github.com/acme/nested-wip.git";
        let (base, remote) = setup_base_with_local_fetch(identity_url);
        let pools = unique_temp("nwr");
        let layout = layout_for(identity_url, &pools);
        let lease = lease_available_or_create_at(&layout, &base, identity_url, &req("nwr1"))
            .await
            .unwrap();
        let nested = lease.worktree_path.join("vendor-repo");
        std::fs::create_dir_all(&nested).unwrap();
        run_git(&nested, &["init", "--quiet", "--initial-branch=main"]);
        run_git(&nested, &["config", "user.email", "nested@example.com"]);
        run_git(&nested, &["config", "user.name", "Nested"]);
        std::fs::write(nested.join("committed.txt"), "base\n").unwrap();
        run_git(&nested, &["add", "committed.txt"]);
        run_git(&nested, &["commit", "--quiet", "-m", "nested base"]);
        let nested_wip = nested.join("UNCOMMITTED_SECRET.txt");
        std::fs::write(&nested_wip, "must-survive\n").unwrap();

        let err = return_abandoned_slot_at(&layout, &base, &req("nwr1"))
            .await
            .unwrap_err();
        assert_eq!(err.code, PoolErrorCode::SnapshotCommitFailed);
        assert!(
            nested_wip.is_file(),
            "nested WIP must remain in quarantined slot"
        );
        assert_eq!(
            std::fs::read_to_string(&nested_wip).unwrap(),
            "must-survive\n"
        );
        let manifest = load_manifest_at(layout.pool_root()).unwrap().unwrap();
        let slot = manifest.slots.get(lease.slot_id.as_str()).unwrap();
        assert_eq!(slot.state, SlotState::Quarantined);
        assert_eq!(
            slot.quarantine_code,
            Some(PoolErrorCode::SnapshotCommitFailed)
        );
        assert!(manifest.bindings.iter().any(|b| b.session_key == "nwr1"));

        cleanup_test_dirs(&[&pools, &base, &remote]);
    }

    #[tokio::test]
    async fn worktree_add_forces_absolute_gitdir_pointer() {
        if !git_available() {
            return;
        }
        let identity_url = "https://github.com/acme/absolute-pointer.git";
        let (base, remote) = setup_base_with_local_fetch(identity_url);
        run_git(&base, &["config", "worktree.useRelativePaths", "true"]);
        let pools = unique_temp("abs");
        let layout = layout_for(identity_url, &pools);
        let lease = lease_available_or_create_at(&layout, &base, identity_url, &req("abs1"))
            .await
            .unwrap();
        let pointer = std::fs::read_to_string(lease.worktree_path.join(".git")).unwrap();
        let raw_path = pointer
            .trim()
            .strip_prefix("gitdir: ")
            .expect("linked worktree pointer");
        assert!(
            Path::new(raw_path).is_absolute(),
            "pool worktree pointer must ignore user relative-path config: {raw_path}"
        );
        assert_pool_tree_owned(&layout, &base, &lease).await;

        cleanup_test_dirs(&[&pools, &base, &remote]);
    }

    #[test]
    fn half_base_pair_rejected() {
        let identity = canonical_repo_identity("github.com/acme/w").unwrap();
        let mut m = empty_manifest(&identity, 1);
        let sid = SlotId::generate().as_str().to_string();
        m.slots.insert(
            sid.clone(),
            SlotRecord {
                slot_id: sid,
                state: SlotState::Preparing,
                last_base_ref: Some("origin/main".into()),
                last_base_oid: None,
                updated_at: now_rfc3339(),
                quarantine_code: None,
                spawn_claim_token: None,
                last_returned_binding: None,
            },
        );
        assert!(validate_manifest(&m).is_err());
    }

    #[test]
    fn github_double_slash_rejected() {
        assert!(canonical_repo_identity("https://github.com/a//b").is_err());
        assert!(canonical_repo_identity("a//b").is_err());
    }

    #[tokio::test]
    async fn exact_binding_mismatch_rejected() {
        if !git_available() {
            return;
        }
        let identity_url = "https://github.com/acme/bind.git";
        let (base, remote) = setup_base_with_local_fetch(identity_url);
        let pools = unique_temp("bd");
        let layout = layout_for(identity_url, &pools);
        let _ = lease_available_or_create_at(&layout, &base, identity_url, &req("b1"))
            .await
            .unwrap();
        let mut wrong = req("b1");
        wrong.run_id = "run-other".into();
        assert_eq!(
            mark_retained_at(&layout, &wrong).await.unwrap_err().code,
            PoolErrorCode::InvalidBinding
        );
        // An exited Run whose session slot now belongs to another Run has
        // nothing to retain; the bound Run still retains its own slot.
        assert!(!retain_exited_at(&layout, &wrong).await.unwrap());
        assert!(retain_exited_at(&layout, &req("b1")).await.unwrap());
        cleanup_test_dirs(&[&pools, &base, &remote]);
    }

    #[test]
    fn credential_like_output_is_sanitized() {
        let s = sanitize_detail(
            "fatal: https://user:super-secret-token@github.com/a/b.git?token=abc#frag denied",
        );
        assert!(!s.contains("super-secret-token"));
        assert!(!s.contains("token=abc"));
        assert!(s.contains("***@") || s.contains("?<redacted>"));
        let scp = sanitize_detail("git@github.com:org/repo.git password=hunter2");
        assert!(!scp.contains("hunter2"));
        let long = "x".repeat(400);
        let bounded = sanitize_detail(&long);
        assert!(bounded.len() <= MAX_SANITIZED_DETAIL + 3);
        // Multi-byte Unicode must not panic on boundary truncation.
        let unicode = format!(
            "{}secret=泄漏密钥token=隐藏值{}",
            "😀".repeat(80),
            "日".repeat(80)
        );
        let out = std::panic::catch_unwind(|| sanitize_detail(&unicode)).expect("no panic");
        assert!(!out.contains("泄漏密钥"));
        assert!(!out.contains("隐藏值"));
        assert!(out.len() <= MAX_SANITIZED_DETAIL + 3);
        // Multiple credential markers all redacted.
        let multi = sanitize_detail(
            "https://a:b@h/r?access_token=tok1&password=pw2 secret=s3 token=t4#frag",
        );
        assert!(!multi.contains("tok1"));
        assert!(!multi.contains("pw2"));
        assert!(!multi.contains("s3"));
        assert!(!multi.contains("t4"));
        // PoolError applies sanitize
        let err = PoolError::new(
            PoolErrorCode::Internal,
            "https://u:p@host/r?access_token=zzz#h",
        );
        assert!(!err.message.contains("access_token=zzz"));
        assert!(!err.message.contains("u:p@"));
    }

    #[tokio::test]
    async fn pool_coordinator_serializes_same_daemon_repo_mutations() {
        let identity_url = "https://github.com/acme/coordinated.git";
        let pools = unique_temp("lb");
        let layout = layout_for(identity_url, &pools);
        let holder = acquire_pool_guard(&layout).await.unwrap();
        let other_layout = layout_for("https://github.com/acme/parallel.git", &pools);
        let other = tokio::time::timeout(
            Duration::from_millis(250),
            acquire_pool_guard(&other_layout),
        )
        .await
        .expect("different repositories must remain parallel")
        .expect("different-repo coordinator must be independent");
        drop(other);
        let waiting_layout = layout.clone();
        let waiter = tokio::spawn(async move { acquire_pool_guard(&waiting_layout).await });
        tokio::time::sleep(Duration::from_millis(75)).await;
        assert!(
            !waiter.is_finished(),
            "same-daemon mutations for one repo must be serialized"
        );
        drop(holder);
        let acquired = tokio::time::timeout(Duration::from_secs(2), waiter)
            .await
            .expect("waiter should acquire after release")
            .expect("waiter task should not fail")
            .expect("daemon coordinator must admit the next mutation");
        drop(acquired);
        assert!(!layout.pool_root().join("pool.lock").exists());
        assert!(!other_layout.pool_root().join("pool.lock").exists());
        let _ = std::fs::remove_dir_all(&pools);
    }

    #[tokio::test]
    async fn foreign_worktree_lock_quarantines_without_unlock() {
        if !git_available() {
            return;
        }
        let identity_url = "https://github.com/acme/foreign-lock.git";
        let (base, remote) = setup_base_with_local_fetch(identity_url);
        let pools = unique_temp("fl");
        let layout = layout_for(identity_url, &pools);
        let lease = lease_available_or_create_at(&layout, &base, identity_url, &req("fl1"))
            .await
            .unwrap();
        // Overwrite lock reason with foreign content.
        let admin = git(
            &lease.worktree_path,
            &["rev-parse", "--absolute-git-dir"],
            GIT_LOCAL_TIMEOUT,
        )
        .await
        .unwrap();
        let locked = PathBuf::from(admin.trim()).join("locked");
        std::fs::write(&locked, "manual-operator-lock\n").unwrap();
        let err = return_abandoned_slot_at(&layout, &base, &req("fl1"))
            .await
            .unwrap_err();
        assert_eq!(err.code, PoolErrorCode::ForeignWorktreeLock);
        quarantined_manifest(&layout, &lease.slot_id, PoolErrorCode::ForeignWorktreeLock);
        // Foreign lock must still be present (we never unlock foreign).
        let still = std::fs::read_to_string(&locked).unwrap();
        assert!(still.contains("manual-operator-lock"));
        cleanup_test_dirs(&[&pools, &base, &remote]);
    }

    #[tokio::test]
    async fn warm_spare_is_built_once_and_taken_by_the_next_new_session() {
        if !git_available() {
            return;
        }
        let identity_url = "https://github.com/acme/warm-spare.git";
        let (base, remote) = setup_base_with_local_fetch(identity_url);
        let pools = unique_temp("ws");
        let layout = layout_for(identity_url, &pools);
        let first = lease_available_or_create_at(&layout, &base, identity_url, &req("w1"))
            .await
            .unwrap();
        assert!(!first.reused_available);

        assert!(
            ensure_warm_spare_at(&layout, &base, identity_url)
                .await
                .unwrap()
        );
        assert!(
            !ensure_warm_spare_at(&layout, &base, identity_url)
                .await
                .unwrap(),
            "one spare is enough"
        );
        let m = load_manifest_at(layout.pool_root()).unwrap().unwrap();
        let spare = m
            .slots
            .values()
            .find(|slot| slot.state == SlotState::Available)
            .expect("spare is Available")
            .slot_id
            .clone();
        let spare_id = SlotId::parse(&spare).unwrap();
        assert_eq!(
            read_worktree_lock_reason(&base, &layout.slot_path(&spare_id).unwrap())
                .await
                .unwrap(),
            Some(pool_worktree_lock_reason(&layout, &spare_id))
        );

        let second = lease_available_or_create_at(&layout, &base, identity_url, &req("w2"))
            .await
            .unwrap();
        assert!(second.reused_available);
        assert_eq!(second.slot_id.as_str(), spare);
        cleanup_test_dirs(&[&pools, &base, &remote]);
    }

    #[tokio::test]
    async fn a_spare_being_built_is_not_reconciled_as_a_crash() {
        let pool_root = unique_temp("wr");
        let slot_id = SlotId::generate();
        let mut manifest = RepoPoolManifest {
            version: MANIFEST_VERSION,
            canonical_repo_identity: "github.com/acme/warm".into(),
            repo_key_id: "k".into(),
            base_repo_path: None,
            slots: BTreeMap::from([(
                slot_id.as_str().to_string(),
                SlotRecord::preparing(&slot_id),
            )]),
            bindings: Vec::new(),
        };
        let warming = WarmingSpare::begin(&pool_root, &slot_id);
        assert!(!reconcile_intermediate_states(&pool_root, &mut manifest));
        drop(warming);
        assert!(reconcile_intermediate_states(&pool_root, &mut manifest));
        assert_eq!(
            manifest.slots[slot_id.as_str()].quarantine_code,
            Some(PoolErrorCode::IntermediateCrash)
        );
    }

    // current_thread so thread-local failpoint is visible across .await points.
    #[tokio::test(flavor = "current_thread")]
    async fn final_manifest_save_failure_no_rentable_slot() {
        if !git_available() {
            return;
        }
        let identity_url = "https://github.com/acme/final-save.git";
        let (base, remote) = setup_base_with_local_fetch(identity_url);
        let pools = unique_temp("fs");
        let layout = layout_for(identity_url, &pools);
        // Create path: save#1 Preparing, save#2 final Leased — fail final.
        TEST_MANIFEST_SAVE_TICK.with(|c| c.set(0));
        TEST_FAIL_MANIFEST_SAVE_ON_TICK.with(|c| c.set(2));
        let err = lease_available_or_create_at(&layout, &base, identity_url, &req("fs1"))
            .await
            .unwrap_err();
        assert_eq!(err.code, PoolErrorCode::Io);
        TEST_FAIL_MANIFEST_SAVE_ON_TICK.with(|c| c.set(0));
        let m = load_manifest_at(layout.pool_root()).unwrap().unwrap();
        // No Available/Leased rentable slot.
        let mut failed_slot_id = None;
        for slot in m.slots.values() {
            assert_ne!(slot.state, SlotState::Available);
            assert_ne!(slot.state, SlotState::Leased);
            failed_slot_id = Some(slot.slot_id.clone());
        }
        let sid = SlotId::parse(failed_slot_id.as_deref().unwrap()).unwrap();
        let path = layout.slot_path(&sid).unwrap();
        assert!(
            path.exists(),
            "failed slot path must remain as orphan evidence"
        );
        let reason = read_worktree_lock_reason(&base, &path)
            .await
            .unwrap()
            .expect("exact owned lock must remain after final-save failure");
        assert_eq!(reason, pool_worktree_lock_reason(&layout, &sid));
        // Re-lease must not treat a phantom Available as reusable.
        let lease2 = lease_available_or_create_at(&layout, &base, identity_url, &req("fs2"))
            .await
            .unwrap();
        assert!(!lease2.reused_available);
        cleanup_test_dirs(&[&pools, &base, &remote]);
    }

    #[tokio::test]
    async fn starting_retry_rotates_token_and_fences_stale_pre_spawn_command() {
        if !git_available() {
            return;
        }
        let identity_url = "https://github.com/acme/spawn-fence.git";
        let (base, remote) = setup_base_with_local_fetch(identity_url);
        let pools = unique_temp("sft");
        let layout = layout_for(identity_url, &pools);
        let request = req("sft1");
        let first = lease_available_or_create_at(&layout, &base, identity_url, &request)
            .await
            .unwrap();
        let second = lease_available_or_create_at(&layout, &base, identity_url, &request)
            .await
            .unwrap();
        assert_eq!(first.slot_id.as_str(), second.slot_id.as_str());
        assert_ne!(first.spawn_claim_token, second.spawn_claim_token);
        let authority = authority_for(&request, &second.slot_id);
        assert_eq!(
            claim_starting_lease_at(
                &layout,
                &authority,
                &first.spawn_claim_token,
                &second.worktree_path,
            )
            .await
            .unwrap_err()
            .code,
            PoolErrorCode::InvalidBinding
        );
        let wrong_cwd = unique_temp("sft-wrong");
        std::fs::create_dir_all(&wrong_cwd).unwrap();
        assert_eq!(
            claim_starting_lease_at(&layout, &authority, &second.spawn_claim_token, &wrong_cwd,)
                .await
                .unwrap_err()
                .code,
            PoolErrorCode::PathEscape
        );
        claim_starting_lease_at(
            &layout,
            &authority,
            &second.spawn_claim_token,
            &second.worktree_path,
        )
        .await
        .unwrap();
        let manifest = load_manifest_at(layout.pool_root()).unwrap().unwrap();
        let slot = manifest.slots.get(second.slot_id.as_str()).unwrap();
        assert_eq!(slot.state, SlotState::Leased);
        assert!(slot.spawn_claim_token.is_none());
        assert_eq!(
            lease_available_or_create_at(&layout, &base, identity_url, &request)
                .await
                .unwrap_err()
                .code,
            PoolErrorCode::InvalidBinding
        );
        cleanup_test_dirs(&[&pools, &base, &remote, &wrong_cwd]);
    }

    #[tokio::test]
    async fn exact_rebind_requires_old_and_new_authority() {
        if !git_available() {
            return;
        }
        let identity_url = "https://github.com/acme/rebind.git";
        let (base, remote) = setup_base_with_local_fetch(identity_url);
        let pools = unique_temp("rb");
        let layout = layout_for(identity_url, &pools);
        let lease = lease_available_or_create_at(&layout, &base, identity_url, &req("rb1"))
            .await
            .unwrap();
        // Leased rebind must be rejected without mutating state/binding.
        let expected_live = authority_for(&req("rb1"), &lease.slot_id);
        claim_starting_lease_at(
            &layout,
            &expected_live,
            &lease.spawn_claim_token,
            &lease.worktree_path,
        )
        .await
        .unwrap();
        let replacement_live = LeaseRequest {
            session_key: "rb1".into(),
            instance_id: "inst-x".into(),
            run_id: "run-x".into(),
            execution_key: "exec-x".into(),
        };
        assert_eq!(
            rebind_retained_lease_at(&layout, &base, &expected_live, &replacement_live)
                .await
                .unwrap_err()
                .code,
            PoolErrorCode::InvalidBinding
        );
        let m_live = load_manifest_at(layout.pool_root()).unwrap().unwrap();
        assert_eq!(
            m_live.slots.get(lease.slot_id.as_str()).unwrap().state,
            SlotState::Leased
        );
        assert_eq!(
            m_live.bindings[0].instance_id, "inst-rb1",
            "binding must be unchanged after rejected Leased rebind"
        );

        mark_retained_at(&layout, &req("rb1")).await.unwrap();
        let expected = authority_for(&req("rb1"), &lease.slot_id);
        // Cross-session replacement rejected; state stays Retained.
        let cross = LeaseRequest {
            session_key: "other-session".into(),
            instance_id: "inst-reborn".into(),
            run_id: "run-reborn".into(),
            execution_key: "exec-reborn".into(),
        };
        assert_eq!(
            rebind_retained_lease_at(&layout, &base, &expected, &cross)
                .await
                .unwrap_err()
                .code,
            PoolErrorCode::InvalidBinding
        );
        let m_cross = load_manifest_at(layout.pool_root()).unwrap().unwrap();
        assert_eq!(
            m_cross.slots.get(lease.slot_id.as_str()).unwrap().state,
            SlotState::Retained
        );
        // Wrong slotId rejected.
        let mut bad = expected.clone();
        bad.slot_id = SlotId::generate().as_str().to_string();
        let same_session = LeaseRequest {
            session_key: "rb1".into(),
            instance_id: "inst-reborn".into(),
            run_id: "run-reborn".into(),
            execution_key: "exec-reborn".into(),
        };
        assert_eq!(
            rebind_retained_lease_at(&layout, &base, &bad, &same_session)
                .await
                .unwrap_err()
                .code,
            PoolErrorCode::InvalidBinding
        );
        // Wrong run_id rejected.
        let mut bad_run = expected.clone();
        bad_run.run_id = "other".into();
        assert_eq!(
            rebind_retained_lease_at(&layout, &base, &bad_run, &same_session)
                .await
                .unwrap_err()
                .code,
            PoolErrorCode::InvalidBinding
        );
        let reborn = rebind_retained_lease_at(&layout, &base, &expected, &same_session)
            .await
            .unwrap();
        assert_eq!(reborn.slot_id.as_str(), lease.slot_id.as_str());
        // Old instance/run authority no longer works for return.
        assert_eq!(
            return_abandoned_slot_at(&layout, &base, &req("rb1"))
                .await
                .unwrap_err()
                .code,
            PoolErrorCode::InvalidBinding
        );
        return_abandoned_slot_at(&layout, &base, &same_session)
            .await
            .unwrap();
        let _ = remote;
    }

    #[tokio::test]
    async fn transfer_moves_retained_slot_to_a_new_session_without_reset() {
        if !git_available() {
            return;
        }
        let identity_url = "https://github.com/acme/handoff.git";
        let (base, remote) = setup_base_with_local_fetch(identity_url);
        let pools = unique_temp("ho");
        let layout = layout_for(identity_url, &pools);
        let lease = lease_available_or_create_at(&layout, &base, identity_url, &req("ho1"))
            .await
            .unwrap();
        let expected_live = authority_for(&req("ho1"), &lease.slot_id);
        claim_starting_lease_at(
            &layout,
            &expected_live,
            &lease.spawn_claim_token,
            &lease.worktree_path,
        )
        .await
        .unwrap();
        std::fs::write(lease.worktree_path.join("DIRTY.txt"), "keep-me").unwrap();
        mark_retained_at(&layout, &req("ho1")).await.unwrap();
        let expected = expected_live;
        let successor = LeaseRequest {
            session_key: "ho-successor".into(),
            instance_id: "inst-succ".into(),
            run_id: "run-succ".into(),
            execution_key: "exec-succ".into(),
        };
        let transferred = transfer_retained_lease_at(&layout, &base, &expected, &successor)
            .await
            .unwrap();
        assert_eq!(transferred.slot_id.as_str(), lease.slot_id.as_str());
        assert_eq!(transferred.worktree_path, lease.worktree_path);
        assert_eq!(
            std::fs::read_to_string(lease.worktree_path.join("DIRTY.txt")).unwrap(),
            "keep-me"
        );
        let manifest = load_manifest_at(layout.pool_root()).unwrap().unwrap();
        assert_eq!(
            manifest.slots.get(lease.slot_id.as_str()).unwrap().state,
            SlotState::Starting
        );
        assert_eq!(manifest.bindings[0].session_key, "ho-successor");
        assert_eq!(manifest.bindings[0].instance_id, "inst-succ");
        assert_eq!(
            transfer_retained_lease_at(&layout, &base, &expected, &successor)
                .await
                .unwrap_err()
                .code,
            PoolErrorCode::InvalidBinding
        );
        let _ = remote;
        cleanup_test_dirs(&[&pools, &base, &remote]);
    }

    #[tokio::test]
    async fn rebind_remote_drift_quarantines_exact_retained_binding() {
        if !git_available() {
            return;
        }
        let identity_url = "https://github.com/acme/rebind-origin.git";
        let (base, remote) = setup_base_with_local_fetch(identity_url);
        let pools = unique_temp("rod");
        let layout = layout_for(identity_url, &pools);
        let lease = lease_available_or_create_at(&layout, &base, identity_url, &req("rod1"))
            .await
            .unwrap();
        mark_retained_at(&layout, &req("rod1")).await.unwrap();
        run_git(
            &base,
            &[
                "remote",
                "set-url",
                "origin",
                "https://github.com/acme/different-origin.git",
            ],
        );
        let expected = authority_for(&req("rod1"), &lease.slot_id);
        let replacement = LeaseRequest {
            session_key: "rod1".into(),
            instance_id: "inst-rod2".into(),
            run_id: "run-rod2".into(),
            execution_key: "exec-rod2".into(),
        };
        let err = rebind_retained_lease_at(&layout, &base, &expected, &replacement)
            .await
            .unwrap_err();
        assert_eq!(err.code, PoolErrorCode::RemoteMismatch);
        let manifest = load_manifest_at(layout.pool_root()).unwrap().unwrap();
        let slot = manifest.slots.get(lease.slot_id.as_str()).unwrap();
        assert_eq!(slot.state, SlotState::Quarantined);
        assert_eq!(slot.quarantine_code, Some(PoolErrorCode::RemoteMismatch));
        assert!(manifest.bindings.iter().any(|binding| {
            binding.session_key == expected.session_key
                && binding.instance_id == expected.instance_id
                && binding.run_id == expected.run_id
                && binding.execution_key == expected.execution_key
                && binding.slot_id == expected.slot_id
        }));

        cleanup_test_dirs(&[&pools, &base, &remote]);
    }

    #[tokio::test]
    async fn reborn_common_dir_mismatch_quarantines() {
        if !git_available() {
            return;
        }
        let identity_url = "https://github.com/acme/common-mismatch.git";
        let (base, remote) = setup_base_with_local_fetch(identity_url);
        let (other_base, other_remote) =
            setup_base_with_local_fetch("https://github.com/acme/other-base.git");
        let pools = unique_temp("cm");
        let layout = layout_for(identity_url, &pools);
        let lease = lease_available_or_create_at(&layout, &base, identity_url, &req("cm1"))
            .await
            .unwrap();
        mark_retained_at(&layout, &req("cm1")).await.unwrap();
        // Point slot path at a worktree from a different base (common-dir mismatch).
        let path = lease.worktree_path.clone();
        replace_with_foreign_worktree(&base, &other_base, &path).await;
        let expected = authority_for(&req("cm1"), &lease.slot_id);
        let replacement = LeaseRequest {
            session_key: "cm1".into(),
            instance_id: "inst-cm1b".into(),
            run_id: "run-cm1b".into(),
            execution_key: "exec-cm1b".into(),
        };
        let err = rebind_retained_lease_at(&layout, &base, &expected, &replacement)
            .await
            .unwrap_err();
        assert!(
            matches!(
                err.code,
                PoolErrorCode::VerifyFailed
                    | PoolErrorCode::ForeignWorktreeLock
                    | PoolErrorCode::PathEscape
                    | PoolErrorCode::WorktreeMissing
            ),
            "got {:?}",
            err.code
        );
        let m = load_manifest_at(layout.pool_root()).unwrap().unwrap();
        assert_eq!(
            m.slots.get(lease.slot_id.as_str()).unwrap().state,
            SlotState::Quarantined
        );
        cleanup_test_dirs(&[&pools, &base, &remote, &other_base, &other_remote]);
    }

    #[tokio::test]
    async fn no_live_return_derives_and_rejects_a_foreign_registered_base() {
        if !git_available() {
            return;
        }
        let identity_url = "https://github.com/acme/no-live-base.git";
        let (base, remote) = setup_base_with_local_fetch(identity_url);
        let (other_base, other_remote) =
            setup_base_with_local_fetch("https://github.com/acme/no-live-foreign.git");
        let pools = unique_temp("nlb");
        let layout = layout_for(identity_url, &pools);
        let request = req("no-live-base");
        let lease = lease_available_or_create_at(&layout, &base, identity_url, &request)
            .await
            .expect("lease no-live fixture");
        mark_retained_at(&layout, &request)
            .await
            .expect("retain no-live fixture");
        let authority = authority_for(&request, &lease.slot_id);

        let path_arg = lease.worktree_path.display().to_string();
        git(&base, &["worktree", "unlock", &path_arg], GIT_LOCAL_TIMEOUT)
            .await
            .expect("unlock original pooled worktree");
        git(
            &base,
            &["worktree", "remove", "--force", &path_arg],
            GIT_MUTATION_TIMEOUT,
        )
        .await
        .expect("remove original pooled worktree");
        let other_oid = git(&other_base, &["rev-parse", "HEAD"], GIT_LOCAL_TIMEOUT)
            .await
            .expect("other base oid");
        git(
            &other_base,
            &["worktree", "add", "--detach", &path_arg, &other_oid],
            GIT_WORKTREE_ADD_TIMEOUT,
        )
        .await
        .expect("install foreign linked worktree at derived slot path");
        std::fs::write(
            lease.worktree_path.join("FOREIGN-WIP.txt"),
            "must survive\n",
        )
        .expect("write foreign sentinel");

        let err = return_retained_authority_without_base_at(&layout, &authority)
            .await
            .expect_err("no-live return must reject a foreign registered base");
        assert_eq!(err.code, PoolErrorCode::RemoteMismatch);
        assert!(
            lease.worktree_path.join("FOREIGN-WIP.txt").is_file(),
            "foreign worktree must not be reset or cleaned"
        );
        let manifest = load_manifest_at(layout.pool_root()).unwrap().unwrap();
        let slot = manifest.slots.get(lease.slot_id.as_str()).unwrap();
        assert_eq!(slot.state, SlotState::Quarantined);
        assert!(manifest.bindings.iter().any(|binding| {
            binding.session_key == authority.session_key
                && binding.instance_id == authority.instance_id
                && binding.run_id == authority.run_id
                && binding.execution_key == authority.execution_key
                && binding.slot_id == authority.slot_id
        }));

        let _ = git(
            &other_base,
            &["worktree", "remove", "--force", &path_arg],
            GIT_MUTATION_TIMEOUT,
        )
        .await;
        cleanup_test_dirs(&[&pools, &base, &remote, &other_base, &other_remote]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unix_pool_modes_owner_private() {
        if !git_available() {
            return;
        }
        let identity_url = "https://github.com/acme/modes.git";
        let (base, remote) = setup_base_with_local_fetch(identity_url);
        let pools = unique_temp("md");
        let layout = layout_for(identity_url, &pools);
        let lease = lease_available_or_create_at(&layout, &base, identity_url, &req("md1"))
            .await
            .unwrap();
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(layout.trusted_pools_root()), 0o700);
        assert_eq!(mode(layout.pool_root()), 0o700);
        assert_eq!(mode(&layout.slots_root()), 0o700);
        assert_eq!(mode(&lease.worktree_path), 0o700);
        assert_eq!(mode(&layout.pool_root().join(MANIFEST_FILE)), 0o600);
        cleanup_test_dirs(&[&pools, &base, &remote]);
    }

    // current_thread for thread-local cleanup failpoints.
    #[tokio::test(flavor = "current_thread")]
    async fn cleanup_remove_failure_keeps_orphan_and_quarantines() {
        if !git_available() {
            return;
        }
        let identity_url = "https://github.com/acme/cleanup-fail.git";
        let (base, remote) = setup_base_with_local_fetch(identity_url);
        let pools = unique_temp("cf");
        let layout = layout_for(identity_url, &pools);

        // --- remove failure via real finalize_create_failure ---
        let lease = lease_available_or_create_at(&layout, &base, identity_url, &req("cf1"))
            .await
            .unwrap();
        let path = lease.worktree_path.clone();
        let slot_id = lease.slot_id.clone();
        // Simulate create-path intermediate: Preparing, no rentable binding.
        let mut m = load_manifest_at(layout.pool_root()).unwrap().unwrap();
        let slot = m.slots.get_mut(slot_id.as_str()).unwrap();
        slot.state = SlotState::Preparing;
        slot.spawn_claim_token = None;
        m.bindings.retain(|b| b.slot_id != slot_id.as_str());
        save_manifest_at(layout.pool_root(), &m).unwrap();

        TEST_FAIL_WORKTREE_REMOVE.with(|c| c.set(true));
        let primary = PoolError::new(PoolErrorCode::WorktreeLockFailed, "simulated lock fail");
        let err = finalize_create_failure(
            layout.pool_root(),
            &mut m,
            &layout,
            &base,
            &path,
            &slot_id,
            primary,
        )
        .await
        .unwrap_err();
        TEST_FAIL_WORKTREE_REMOVE.with(|c| c.set(false));
        assert_eq!(err.code, PoolErrorCode::WorktreeCleanupFailed);
        assert!(path.exists(), "orphan path must remain");
        assert!(path.join(".git").is_file());
        // Owned lock restored after unlock+remove-fail.
        let reason = read_worktree_lock_reason(&base, &path)
            .await
            .unwrap()
            .expect("exact owned lock restored after remove failure");
        assert_eq!(reason, pool_worktree_lock_reason(&layout, &slot_id));
        // Disk quarantine persisted by finalizer.
        let m2 = load_manifest_at(layout.pool_root()).unwrap().unwrap();
        let slot = m2.slots.get(slot_id.as_str()).unwrap();
        assert_eq!(slot.state, SlotState::Quarantined);
        assert_eq!(
            slot.quarantine_code,
            Some(PoolErrorCode::WorktreeCleanupFailed)
        );
        assert!(
            !m2.bindings.iter().any(|b| b.slot_id == slot_id.as_str()),
            "failed create slot must not remain rentable via binding"
        );
        // Not reusable as Available.
        let again = lease_available_or_create_at(&layout, &base, identity_url, &req("cf1b"))
            .await
            .unwrap();
        assert!(!again.reused_available);
        assert_ne!(again.slot_id.as_str(), slot_id.as_str());

        // --- foreign lock: finalizer must not unlock/remove ---
        let lease2 = lease_available_or_create_at(&layout, &base, identity_url, &req("cf2"))
            .await
            .unwrap();
        let mut m3 = load_manifest_at(layout.pool_root()).unwrap().unwrap();
        let slot2 = m3.slots.get_mut(lease2.slot_id.as_str()).unwrap();
        slot2.state = SlotState::Preparing;
        slot2.spawn_claim_token = None;
        m3.bindings.retain(|b| b.slot_id != lease2.slot_id.as_str());
        save_manifest_at(layout.pool_root(), &m3).unwrap();
        let admin = resolve_validated_worktree_admin(&base, &lease2.worktree_path)
            .await
            .unwrap();
        let locked = admin.join("locked");
        std::fs::write(&locked, "foreign-operator\n").unwrap();
        let err_f = finalize_create_failure(
            layout.pool_root(),
            &mut m3,
            &layout,
            &base,
            &lease2.worktree_path,
            &lease2.slot_id,
            PoolError::new(PoolErrorCode::WorktreeCreateFailed, "primary"),
        )
        .await
        .unwrap_err();
        assert_eq!(err_f.code, PoolErrorCode::ForeignWorktreeLock);
        assert!(lease2.worktree_path.exists());
        assert!(
            std::fs::read_to_string(&locked)
                .unwrap()
                .contains("foreign-operator")
        );
        let m4 = load_manifest_at(layout.pool_root()).unwrap().unwrap();
        assert_eq!(
            m4.slots.get(lease2.slot_id.as_str()).unwrap().state,
            SlotState::Quarantined
        );
        assert_eq!(
            m4.slots
                .get(lease2.slot_id.as_str())
                .unwrap()
                .quarantine_code,
            Some(PoolErrorCode::ForeignWorktreeLock)
        );

        // --- unlock failure: owned lock remains, quarantine via finalizer ---
        let lease3 = lease_available_or_create_at(&layout, &base, identity_url, &req("cf3"))
            .await
            .unwrap();
        let mut m5 = load_manifest_at(layout.pool_root()).unwrap().unwrap();
        let slot3 = m5.slots.get_mut(lease3.slot_id.as_str()).unwrap();
        slot3.state = SlotState::Preparing;
        slot3.spawn_claim_token = None;
        m5.bindings.retain(|b| b.slot_id != lease3.slot_id.as_str());
        save_manifest_at(layout.pool_root(), &m5).unwrap();
        TEST_FAIL_WORKTREE_UNLOCK.with(|c| c.set(true));
        let err_u = finalize_create_failure(
            layout.pool_root(),
            &mut m5,
            &layout,
            &base,
            &lease3.worktree_path,
            &lease3.slot_id,
            PoolError::new(PoolErrorCode::WorktreeCreateFailed, "primary"),
        )
        .await
        .unwrap_err();
        TEST_FAIL_WORKTREE_UNLOCK.with(|c| c.set(false));
        assert_eq!(err_u.code, PoolErrorCode::WorktreeCleanupFailed);
        let still = read_worktree_lock_reason(&base, &lease3.worktree_path)
            .await
            .unwrap()
            .expect("owned lock must remain when unlock fails");
        assert_eq!(still, pool_worktree_lock_reason(&layout, &lease3.slot_id));
        let m6 = load_manifest_at(layout.pool_root()).unwrap().unwrap();
        assert_eq!(
            m6.slots.get(lease3.slot_id.as_str()).unwrap().state,
            SlotState::Quarantined
        );

        cleanup_test_dirs(&[&pools, &base, &remote]);
    }

    #[tokio::test]
    async fn fake_external_gitdir_admin_rejected() {
        if !git_available() {
            return;
        }
        let identity_url = "https://github.com/acme/fake-admin.git";
        let (base, remote) = setup_base_with_local_fetch(identity_url);
        let pools = unique_temp("fa");
        let layout = layout_for(identity_url, &pools);
        let lease = lease_available_or_create_at(&layout, &base, identity_url, &req("fa1"))
            .await
            .unwrap();
        let outside = unique_temp("faout");
        // Build fake admin that points commondir back at the real base common-dir.
        let real_common = git(
            &base,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
            GIT_LOCAL_TIMEOUT,
        )
        .await
        .unwrap();
        let fake_admin = outside.join("evil-admin");
        std::fs::create_dir_all(&fake_admin).unwrap();
        std::fs::write(
            fake_admin.join("commondir"),
            format!("{}\n", real_common.trim()),
        )
        .unwrap();
        std::fs::write(fake_admin.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        std::fs::write(fake_admin.join("locked"), "xmatrix-repo-pool:forged\n").unwrap();
        // Point slot .git at external admin.
        let git_file = lease.worktree_path.join(".git");
        std::fs::write(&git_file, format!("gitdir: {}\n", fake_admin.display())).unwrap();
        let err =
            verify_pool_worktree_ownership(&layout, &base, &lease.worktree_path, &lease.slot_id)
                .await
                .unwrap_err();
        assert!(
            matches!(
                err.code,
                PoolErrorCode::PathEscape | PoolErrorCode::VerifyFailed
            ),
            "got {:?}",
            err.code
        );
        // Oversize locked file under a real admin should also fail closed.
        let lease2 = lease_available_or_create_at(&layout, &base, identity_url, &req("fa2"))
            .await
            .unwrap();
        let admin2 = resolve_validated_worktree_admin(&base, &lease2.worktree_path)
            .await
            .unwrap();
        let big = "L".repeat((MAX_LOCK_REASON_BYTES as usize) + 8);
        std::fs::write(admin2.join("locked"), big).unwrap();
        let err_big = read_worktree_lock_reason(&base, &lease2.worktree_path)
            .await
            .unwrap_err();
        assert_eq!(err_big.code, PoolErrorCode::VerifyFailed);
        // locked as directory / non-file rejected
        let lease3 = lease_available_or_create_at(&layout, &base, identity_url, &req("fa3"))
            .await
            .unwrap();
        let admin3 = resolve_validated_worktree_admin(&base, &lease3.worktree_path)
            .await
            .unwrap();
        let locked3 = admin3.join("locked");
        let _ = std::fs::remove_file(&locked3);
        std::fs::create_dir(&locked3).unwrap();
        let err_dir = read_worktree_lock_reason(&base, &lease3.worktree_path)
            .await
            .unwrap_err();
        assert!(matches!(
            err_dir.code,
            PoolErrorCode::VerifyFailed | PoolErrorCode::PathEscape | PoolErrorCode::Io
        ));
        // locked as symlink must fail closed without reading target.
        let lease4 = lease_available_or_create_at(&layout, &base, identity_url, &req("fa4"))
            .await
            .unwrap();
        let admin4 = resolve_validated_worktree_admin(&base, &lease4.worktree_path)
            .await
            .unwrap();
        let locked4 = admin4.join("locked");
        let outside_locked = outside.join("secret-locked");
        std::fs::write(&outside_locked, "SECRET_LOCK_CONTENT\n").unwrap();
        let _ = std::fs::remove_file(&locked4);
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside_locked, &locked4).unwrap();
        #[cfg(windows)]
        {
            // Windows: junction/symlink may need elevation; skip if unavailable.
            let status = std::process::Command::new("cmd")
                .args([
                    "/C",
                    "mklink",
                    &locked4.display().to_string(),
                    &outside_locked.display().to_string(),
                ])
                .status()
                .unwrap();
            if !status.success() {
                cleanup_test_dirs(&[&pools, &outside, &base, &remote]);
                return;
            }
        }
        let err_sym = read_worktree_lock_reason(&base, &lease4.worktree_path)
            .await
            .unwrap_err();
        assert!(
            matches!(
                err_sym.code,
                PoolErrorCode::PathEscape | PoolErrorCode::VerifyFailed
            ),
            "got {:?}",
            err_sym.code
        );
        assert_eq!(
            std::fs::read_to_string(&outside_locked).unwrap(),
            "SECRET_LOCK_CONTENT\n",
            "outside locked target must not be modified"
        );
        cleanup_test_dirs(&[&pools, &outside, &base, &remote]);
    }

    #[test]
    fn oversized_manifest_not_fully_loaded() {
        let root = unique_temp("big");
        // Regular file larger than MAX_MANIFEST_BYTES: must fail before unbounded read.
        let big = vec![b'x'; MAX_MANIFEST_BYTES + 64];
        std::fs::write(root.join(MANIFEST_FILE), &big).unwrap();
        let err = load_manifest_at(&root).unwrap_err();
        assert_eq!(err.code, PoolErrorCode::ManifestCorrupt);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn strip_extended_length_prefix_drive_and_unc() {
        let drive = strip_extended_length_prefix(PathBuf::from(r"\\?\C:\Users\x\repo"));
        assert_eq!(drive, PathBuf::from(r"C:\Users\x\repo"));
        let unc = strip_extended_length_prefix(PathBuf::from(r"\\?\UNC\server\share\repo"));
        assert_eq!(
            unc,
            PathBuf::from(r"\\server\share\repo"),
            "UNC must not become relative UNC\\server\\..."
        );
        let plain = strip_extended_length_prefix(PathBuf::from(r"C:\plain\path"));
        assert_eq!(plain, PathBuf::from(r"C:\plain\path"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unix_manifest_symlink_to_outside_rejected() {
        if !git_available() {
            return;
        }
        let identity_url = "https://github.com/acme/ctrl-sym.git";
        let (base, remote) = setup_base_with_local_fetch(identity_url);
        let pools = unique_temp("cs");
        let layout = layout_for(identity_url, &pools);
        // Establish a real pool manifest first.
        let _ = lease_available_or_create_at(&layout, &base, identity_url, &req("cs1"))
            .await
            .unwrap();
        let outside = unique_temp("csout");
        let outside_json = outside.join("victim.json");
        std::fs::write(&outside_json, b"OUTSIDE_JSON_UNTOUCHED").unwrap();
        let json_path = layout.pool_root().join(MANIFEST_FILE);
        let _ = std::fs::remove_file(&json_path);
        std::os::unix::fs::symlink(&outside_json, &json_path).unwrap();
        // load must refuse symlink (no follow / no full read of outside).
        let err_load = load_manifest_at(layout.pool_root()).unwrap_err();
        assert_eq!(err_load.code, PoolErrorCode::PathEscape);
        assert_eq!(
            std::fs::read(&outside_json).unwrap(),
            b"OUTSIDE_JSON_UNTOUCHED"
        );
        cleanup_test_dirs(&[&pools, &outside, &base, &remote]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unix_symlink_above_worktrees_boundary_still_accepts() {
        if !git_available() {
            return;
        }
        let identity_url = "https://github.com/acme/sym-above.git";
        let (base, remote) = setup_base_with_local_fetch(identity_url);
        let pools = unique_temp("sap");
        let layout = layout_for(identity_url, &pools);
        let lease = lease_available_or_create_at(&layout, &base, identity_url, &req("sa1"))
            .await
            .expect("lease through symlink parent must succeed");

        // Rewrite the linked-worktree pointer through a symlink *above* the
        // canonical common-dir/worktrees boundary. The canonical admin remains
        // the same direct worktrees child, so this is a legitimate spelling.
        // The old filesystem-root component walk rejected this alias.
        let real_admin = resolve_validated_worktree_admin(&base, &lease.worktree_path)
            .await
            .unwrap();
        let common_raw = git(
            &base,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
            GIT_LOCAL_TIMEOUT,
        )
        .await
        .unwrap();
        let common = PathBuf::from(common_raw.trim());
        let alias_root = unique_temp("saa");
        let common_alias = alias_root.join("common-alias");
        std::os::unix::fs::symlink(&common, &common_alias).unwrap();
        let alias_admin = common_alias
            .join("worktrees")
            .join(real_admin.file_name().unwrap());
        std::fs::write(
            lease.worktree_path.join(".git"),
            format!("gitdir: {}\n", alias_admin.display()),
        )
        .unwrap();
        resolve_validated_worktree_admin(&base, &lease.worktree_path)
            .await
            .expect("admin alias above the trusted worktrees boundary must be accepted");
        let reason = read_worktree_lock_reason(&base, &lease.worktree_path)
            .await
            .unwrap()
            .expect("owned lock readable");
        assert_eq!(reason, pool_worktree_lock_reason(&layout, &lease.slot_id));

        // In contrast, the admin leaf itself may not be a symlink, even when
        // it resolves to the real direct child.
        let lease2 = lease_available_or_create_at(&layout, &base, identity_url, &req("sa2"))
            .await
            .unwrap();
        let real_admin2 = resolve_validated_worktree_admin(&base, &lease2.worktree_path)
            .await
            .unwrap();
        let admin_leaf_alias = alias_root.join("admin-leaf-alias");
        std::os::unix::fs::symlink(&real_admin2, &admin_leaf_alias).unwrap();
        std::fs::write(
            lease2.worktree_path.join(".git"),
            format!("gitdir: {}\n", admin_leaf_alias.display()),
        )
        .unwrap();
        let err = resolve_validated_worktree_admin(&base, &lease2.worktree_path)
            .await
            .unwrap_err();
        assert_eq!(err.code, PoolErrorCode::PathEscape);

        cleanup_test_dirs(&[&base, &remote, &pools, &alias_root]);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn new_slot_create_fails_closed_below_disk_watermark() {
        if !git_available() {
            return;
        }
        struct ResetDiskMin;
        impl Drop for ResetDiskMin {
            fn drop(&mut self) {
                crate::run_worktree::set_test_disk_min_bytes(None);
            }
        }
        let _reset = ResetDiskMin;
        crate::run_worktree::set_test_disk_min_bytes(Some(u64::MAX));
        let identity_url = "https://github.com/acme/disk-gate";
        let (base, remote) = setup_base_with_local_fetch(identity_url);
        let pools = unique_temp("dp");
        let layout = layout_for(identity_url, &pools);
        let err = lease_available_or_create_at(&layout, &base, identity_url, &req("dg1"))
            .await
            .expect_err("create must fail closed");
        crate::run_worktree::set_test_disk_min_bytes(None);
        assert_eq!(err.code, PoolErrorCode::DiskExhausted);
        cleanup_test_dirs(&[&base, &remote, &pools]);
    }

    /// The sweep's whole job is to stop trusting a recorded state on its own,
    /// so every case below is expressed as "who does liveness still claim".
    fn claims(slot_ids: &[&str]) -> PoolLiveness {
        PoolLiveness {
            slot_ids: slot_ids.iter().map(|id| id.to_string()).collect(),
            cwds: BTreeSet::new(),
        }
    }

    /// Hold the shipped idle floors against a sibling test lowering them. The
    /// floors are process-wide env, so any test that asserts one protects a
    /// slot has to own the same lock as the tests that turn them off.
    fn default_idle_floors() -> std::sync::MutexGuard<'static, ()> {
        let guard = crate::test_process_env_lock();
        // This guard owns the crate's process-wide env lock.
        unsafe {
            std::env::remove_var(REPO_POOL_ORPHAN_MIN_AGE_SECS_ENV);
            std::env::remove_var(REPO_POOL_EVICT_MIN_IDLE_SECS_ENV);
        }
        guard
    }

    /// Age out both idle floors so a freshly minted slot is sweepable. Holds
    /// the crate's process-wide env lock for as long as the floors are lowered.
    struct NoIdleFloors {
        _lock: std::sync::MutexGuard<'static, ()>,
    }

    impl NoIdleFloors {
        fn enter() -> Self {
            let guard = crate::test_process_env_lock();
            // This guard owns the crate's process-wide env lock.
            unsafe {
                std::env::set_var(REPO_POOL_ORPHAN_MIN_AGE_SECS_ENV, "0");
                std::env::set_var(REPO_POOL_EVICT_MIN_IDLE_SECS_ENV, "0");
                std::env::set_var(REPO_POOL_RESTING_EVICT_SECS_ENV, "0");
            }
            Self { _lock: guard }
        }
    }

    impl Drop for NoIdleFloors {
        fn drop(&mut self) {
            unsafe {
                std::env::remove_var(REPO_POOL_ORPHAN_MIN_AGE_SECS_ENV);
                std::env::remove_var(REPO_POOL_EVICT_MIN_IDLE_SECS_ENV);
                std::env::remove_var(REPO_POOL_RESTING_EVICT_SECS_ENV);
            }
        }
    }

    #[tokio::test]
    async fn sweep_evicts_surplus_idle_slots_but_never_a_claimed_one() {
        if !git_available() {
            return;
        }
        let _floors = NoIdleFloors::enter();
        let identity_url = "https://github.com/acme/evict-available";
        let (base, remote) = setup_base_with_local_fetch(identity_url);
        let pools = unique_temp("ev");
        let layout = layout_for(identity_url, &pools);
        let lease = lease_available_or_create_at(&layout, &base, identity_url, &req("ev1"))
            .await
            .unwrap();
        let slot = lease.slot_id.as_str().to_string();
        mark_retained_at(&layout, &req("ev1")).await.unwrap();
        let outcome = reclaim_pool_slots_at(&pools, &claims(&[&slot]), 0).await;
        assert!(
            outcome.evicted.is_empty(),
            "a slot its run still claims must survive even at keep_idle 0"
        );
        return_abandoned_slot_at(&layout, &base, &req("ev1"))
            .await
            .unwrap();
        let outcome = reclaim_pool_slots_at(&pools, &PoolLiveness::default(), 1).await;
        assert!(
            outcome.evicted.is_empty(),
            "the warm-cache budget is honored"
        );
        assert!(lease.worktree_path.exists());
        let outcome = reclaim_pool_slots_at(&pools, &PoolLiveness::default(), 0).await;
        assert_evicted_tree(&outcome, &slot, &lease.worktree_path);
        let manifest = load_manifest_at(layout.pool_root()).unwrap().unwrap();
        assert!(!manifest.slots.contains_key(&slot));
        cleanup_test_dirs(&[&base, &remote, &pools]);
    }

    #[tokio::test]
    async fn stranded_lease_returns_to_the_reusable_pool() {
        if !git_available() {
            return;
        }
        let _floors = NoIdleFloors::enter();
        let identity_url = "https://github.com/acme/stranded-lease";
        let (base, remote) = setup_base_with_local_fetch(identity_url);
        let pools = unique_temp("sl");
        let layout = layout_for(identity_url, &pools);
        // A crash or self-update never reaches the typed stop, so the slot is
        // left exactly as the lease wrote it.
        let lease = lease_available_or_create_at(&layout, &base, identity_url, &req("sl1"))
            .await
            .unwrap();
        let slot = lease.slot_id.as_str().to_string();
        // A lease that never reached pre-spawn admission rests in Starting and
        // still carries its one-shot claim token.
        assert_eq!(state_of(&layout, &slot), SlotState::Starting);

        let outcome = reclaim_pool_slots_at(&pools, &claims(&[&slot]), 8).await;
        assert!(
            outcome.demoted.is_empty(),
            "a live process still owns this tree"
        );
        assert_eq!(state_of(&layout, &slot), SlotState::Starting);

        let outcome = reclaim_pool_slots_at(&pools, &PoolLiveness::default(), 8).await;
        assert_eq!(outcome.demoted, vec![slot.clone()]);
        assert_eq!(state_of(&layout, &slot), SlotState::Retained);
        assert!(
            load_manifest_at(layout.pool_root())
                .unwrap()
                .unwrap()
                .slots
                .get(&slot)
                .unwrap()
                .spawn_claim_token
                .is_none(),
            "a returned lease must not keep a live spawn claim"
        );
        assert!(
            lease.worktree_path.exists(),
            "demotion must not touch the tree"
        );
        // Retained for its session now: a new session grows the pool, and a
        // later sweep reclaims the tree behind a rehydrate record.
        let next = lease_available_or_create_at(&layout, &base, identity_url, &req("sl2"))
            .await
            .unwrap();
        assert_ne!(next.slot_id.as_str(), slot);
        let outcome = reclaim_pool_slots_at(&pools, &claims(&[next.slot_id.as_str()]), 8).await;
        assert_eq!(outcome.evicted, vec![slot.clone()]);
        assert!(
            rehydrate_record_for_session_at(&layout, "sl1")
                .await
                .unwrap()
                .is_some()
        );
        cleanup_test_dirs(&[&base, &remote, &pools]);
    }

    #[tokio::test]
    async fn demotion_keeps_the_recency_the_eviction_budget_reads() {
        if !git_available() {
            return;
        }
        let _floors = NoIdleFloors::enter();
        let identity_url = "https://github.com/acme/demote-recency";
        let (base, remote) = setup_base_with_local_fetch(identity_url);
        let pools = unique_temp("dr");
        let layout = layout_for(identity_url, &pools);
        let stranded = lease_available_or_create_at(&layout, &base, identity_url, &req("dr1"))
            .await
            .unwrap();
        let stranded_id = stranded.slot_id.as_str().to_string();
        let before = load_manifest_at(layout.pool_root())
            .unwrap()
            .unwrap()
            .slots
            .get(&stranded_id)
            .unwrap()
            .updated_at
            .clone();

        let outcome = reclaim_pool_slots_at(&pools, &PoolLiveness::default(), 8).await;
        assert_eq!(outcome.demoted, vec![stranded_id.clone()]);
        // Stamping the correction would make the most stranded slot look like
        // the freshest one, so the budget would spare it and evict a warm tree.
        assert_eq!(
            load_manifest_at(layout.pool_root())
                .unwrap()
                .unwrap()
                .slots
                .get(&stranded_id)
                .unwrap()
                .updated_at,
            before,
            "a bookkeeping correction is not activity"
        );
        cleanup_test_dirs(&[&base, &remote, &pools]);
    }

    #[tokio::test]
    async fn a_young_stranded_lease_is_left_alone() {
        if !git_available() {
            return;
        }
        let _floors = default_idle_floors();
        let identity_url = "https://github.com/acme/young-lease";
        let (base, remote) = setup_base_with_local_fetch(identity_url);
        let pools = unique_temp("yl");
        let layout = layout_for(identity_url, &pools);
        let lease = lease_available_or_create_at(&layout, &base, identity_url, &req("yl1"))
            .await
            .unwrap();
        let slot = lease.slot_id.as_str().to_string();
        // The run-registry row is written after the lease. Inside that window a
        // live run looks stranded, and demoting it would reset --hard the tree
        // out from under a running agent.
        let outcome = reclaim_pool_slots_at(&pools, &PoolLiveness::default(), 8).await;
        assert!(outcome.demoted.is_empty());
        assert!(outcome.evicted.is_empty());
        assert_eq!(state_of(&layout, &slot), SlotState::Starting);
        cleanup_test_dirs(&[&base, &remote, &pools]);
    }

    #[tokio::test]
    async fn a_recently_touched_slot_survives_even_with_no_liveness_evidence() {
        if !git_available() {
            return;
        }
        let _floors = default_idle_floors();
        let identity_url = "https://github.com/acme/busy-slot";
        let (base, remote) = setup_base_with_local_fetch(identity_url);
        let pools = unique_temp("bs");
        let layout = layout_for(identity_url, &pools);
        let lease = lease_available_or_create_at(&layout, &base, identity_url, &req("bs1"))
            .await
            .unwrap();
        mark_retained_at(&layout, &req("bs1")).await.unwrap();
        // The daemon run registry is rebuilt from sidecars and can be empty
        // while agents are working, so an empty liveness set is not evidence
        // that nobody is in this tree. A fresh mtime is.
        let outcome = reclaim_pool_slots_at(&pools, &PoolLiveness::default(), 0).await;
        assert!(outcome.evicted.is_empty(), "recent work must hold the slot");
        assert!(outcome.demoted.is_empty());
        assert!(lease.worktree_path.exists());
        cleanup_test_dirs(&[&base, &remote, &pools]);
    }

    #[tokio::test]
    async fn quarantined_slots_are_given_up_before_reusable_ones() {
        if !git_available() {
            return;
        }
        let _floors = NoIdleFloors::enter();
        let identity_url = "https://github.com/acme/quarantine-evict";
        let (base, remote) = setup_base_with_local_fetch(identity_url);
        let pools = unique_temp("qe");
        let layout = layout_for(identity_url, &pools);
        let lease = lease_available_or_create_at(&layout, &base, identity_url, &req("qe1"))
            .await
            .unwrap();
        let slot = lease.slot_id.as_str().to_string();
        mark_retained_at(&layout, &req("qe1")).await.unwrap();
        // A quarantined tree is never offered to a session again, so it is pure
        // dead weight; the old sweep left it on disk forever.
        let mut manifest = load_manifest_at(layout.pool_root()).unwrap().unwrap();
        manifest.slots.get_mut(&slot).unwrap().state = SlotState::Quarantined;
        manifest.slots.get_mut(&slot).unwrap().quarantine_code =
            Some(PoolErrorCode::FetchRequiredFailed);
        save_manifest_at(layout.pool_root(), &manifest).unwrap();

        // Budget room to spare, and it still goes: the budget only protects
        // slots a session could actually reuse.
        let outcome = reclaim_pool_slots_at(&pools, &PoolLiveness::default(), 8).await;
        assert_evicted_tree(&outcome, &slot, &lease.worktree_path);
        cleanup_test_dirs(&[&base, &remote, &pools]);
    }

    #[tokio::test]
    async fn a_slot_whose_repository_is_gone_is_archived_not_retried() {
        if !git_available() {
            return;
        }
        let _floors = NoIdleFloors::enter();
        let identity_url = "https://github.com/acme/evict-orphan";
        let (base, remote) = setup_base_with_local_fetch(identity_url);
        let pools = unique_temp("eo");
        let layout = layout_for(identity_url, &pools);
        let lease = lease_available_or_create_at(&layout, &base, identity_url, &req("eo1"))
            .await
            .unwrap();
        let slot = lease.slot_id.as_str().to_string();
        mark_retained_at(&layout, &req("eo1")).await.unwrap();
        std::fs::write(lease.worktree_path.join("unlanded.txt"), "keep me").unwrap();
        // The tree's repository disappears (another account's clone, deleted).
        std::fs::write(
            lease.worktree_path.join(".git"),
            "gitdir: /nonexistent/clone/.git/worktrees/gone\n",
        )
        .unwrap();

        let outcome = reclaim_pool_slots_at(&pools, &PoolLiveness::default(), 0).await;
        let manifest = load_manifest_at(layout.pool_root()).unwrap().unwrap();
        assert!(outcome.evicted.contains(&slot) && !manifest.slots.contains_key(&slot));
        assert!(!lease.worktree_path.exists());
        let archived = layout.pool_root().join("orphaned").join(&slot);
        assert_eq!(
            std::fs::read_to_string(archived.join("unlanded.txt")).unwrap(),
            "keep me",
            "the archived tree keeps its files"
        );
        cleanup_test_dirs(&[&base, &remote, &pools]);
    }

    #[tokio::test]
    async fn evicting_a_retained_slot_preserves_its_un_landed_work() {
        if !git_available() {
            return;
        }
        let _floors = NoIdleFloors::enter();
        let identity_url = "https://github.com/acme/evict-dirty";
        let (base, remote) = setup_base_with_local_fetch(identity_url);
        let pools = unique_temp("ed");
        let layout = layout_for(identity_url, &pools);
        let lease = lease_available_or_create_at(&layout, &base, identity_url, &req("ed1"))
            .await
            .unwrap();
        let slot = lease.slot_id.as_str().to_string();
        mark_retained_at(&layout, &req("ed1")).await.unwrap();
        // Eviction was only ever reachable for freshly reset Available slots.
        // A Retained slot holds real session work, and removal is --force.
        std::fs::write(lease.worktree_path.join("unlanded.txt"), "keep me").unwrap();

        let outcome = reclaim_pool_slots_at(&pools, &PoolLiveness::default(), 0).await;
        assert_evicted_tree(&outcome, &slot, &lease.worktree_path);

        let refs = std::process::Command::new("git")
            .args([
                "-C",
                base.to_str().unwrap(),
                "for-each-ref",
                "--format=%(refname)",
                &format!("refs/xmatrix/snapshot/{slot}/*"),
            ])
            .output()
            .unwrap();
        let snapshot = String::from_utf8(refs.stdout).unwrap();
        let snapshot = snapshot.trim();
        assert!(!snapshot.is_empty(), "eviction must pin un-landed work");
        let blob = std::process::Command::new("git")
            .args([
                "-C",
                base.to_str().unwrap(),
                "show",
                &format!("{snapshot}:unlanded.txt"),
            ])
            .output()
            .unwrap();
        assert_eq!(String::from_utf8(blob.stdout).unwrap(), "keep me");
        cleanup_test_dirs(&[&base, &remote, &pools]);
    }

    #[tokio::test]
    async fn records_for_vanished_slot_directories_are_pruned() {
        if !git_available() {
            return;
        }
        let _floors = NoIdleFloors::enter();
        let identity_url = "https://github.com/acme/vanished-slot";
        let (base, remote) = setup_base_with_local_fetch(identity_url);
        let pools = unique_temp("vs");
        let layout = layout_for(identity_url, &pools);
        let lease = lease_available_or_create_at(&layout, &base, identity_url, &req("vs1"))
            .await
            .unwrap();
        let slot = lease.slot_id.as_str().to_string();
        mark_retained_at(&layout, &req("vs1")).await.unwrap();
        assert_missing_checkout_pruned(&pools, &lease.worktree_path, &slot).await;
        let manifest = load_manifest_at(layout.pool_root()).unwrap().unwrap();
        assert!(!manifest.slots.contains_key(&slot));
        assert!(
            !manifest.bindings.iter().any(|b| b.slot_id == slot),
            "a pruned record must not leave its binding behind"
        );
        cleanup_test_dirs(&[&base, &remote, &pools]);
    }

    #[tokio::test]
    async fn new_lease_leaves_a_recent_session_its_slot_for_reborn() {
        if !git_available() {
            return;
        }
        let _lock = crate::test_process_env_lock();
        let identity_url = "https://github.com/acme/held-retained";
        let (base, remote) = setup_base_with_local_fetch(identity_url);
        let pools = unique_temp("hr");
        let layout = layout_for(identity_url, &pools);
        let first = lease_available_or_create_at(&layout, &base, identity_url, &req("hr1"))
            .await
            .unwrap();
        std::fs::write(first.worktree_path.join("WIP.txt"), "dirty\n").unwrap();
        mark_retained_at(&layout, &req("hr1")).await.unwrap();

        let second = lease_available_or_create_at(&layout, &base, identity_url, &req("hr2"))
            .await
            .unwrap();
        assert!(
            !second.reused_available,
            "the pool grows instead of displacing hr1"
        );
        assert_ne!(first.slot_id.as_str(), second.slot_id.as_str());
        assert!(
            first.worktree_path.join("WIP.txt").is_file(),
            "the stopped session's checkout is left exactly as it was"
        );
        let manifest = load_manifest_at(layout.pool_root()).unwrap().unwrap();
        assert!(
            manifest
                .bindings
                .iter()
                .any(|b| b.session_key == req("hr1").session_key
                    && b.slot_id == first.slot_id.as_str()),
            "hr1 can still be reborn into its own slot"
        );
        assert!(
            retained_binding_for_unissued_reborn_at(
                &pools,
                layout.repo_key(),
                &req("hr1").session_key
            )
            .await
            .unwrap()
            .is_some()
        );
        cleanup_test_dirs(&[&base, &remote, &pools]);
    }

    #[tokio::test]
    async fn new_lease_never_displaces_a_resting_session_however_cold() {
        if !git_available() {
            return;
        }
        let _floors = NoIdleFloors::enter();
        let identity_url = "https://github.com/acme/recycle-retained";
        let (base, remote) = setup_base_with_local_fetch(identity_url);
        let pools = unique_temp("rc");
        let layout = layout_for(identity_url, &pools);
        let first = lease_available_or_create_at(&layout, &base, identity_url, &req("rc1"))
            .await
            .unwrap();
        std::fs::write(first.worktree_path.join("WIP.txt"), "dirty\n").unwrap();
        mark_retained_at(&layout, &req("rc1")).await.unwrap();

        // Its slot is where rc1 wakes: a new session grows the pool instead,
        // and only the reclaim sweep gives rc1's disk back, with a record.
        let second = lease_available_or_create_at(&layout, &base, identity_url, &req("rc2"))
            .await
            .unwrap();
        assert!(!second.reused_available);
        assert_ne!(first.slot_id.as_str(), second.slot_id.as_str());
        assert!(first.worktree_path.join("WIP.txt").is_file());
        let manifest = load_manifest_at(layout.pool_root()).unwrap().unwrap();
        assert!(
            manifest
                .bindings
                .iter()
                .any(|b| b.session_key == "rc1" && b.slot_id == first.slot_id.as_str())
        );

        cleanup_test_dirs(&[&base, &remote, &pools]);
    }

    #[tokio::test]
    async fn a_reclaimed_resting_session_rehydrates_in_place_with_its_work() {
        if !git_available() {
            return;
        }
        let _floors = NoIdleFloors::enter();
        let identity_url = "https://github.com/acme/rehydrate";
        let (base, remote) = setup_base_with_local_fetch(identity_url);
        let pools = unique_temp("rh");
        let layout = layout_for(identity_url, &pools);
        let lease = lease_available_or_create_at(&layout, &base, identity_url, &req("rh1"))
            .await
            .unwrap();
        let tree = lease.worktree_path.clone();
        let slot = lease.slot_id.as_str().to_string();
        commit_unpushed_work(&tree, "feat/rest");
        std::fs::write(tree.join("draft.txt"), "uncommitted\n").unwrap();
        mark_retained_at(&layout, &req("rh1")).await.unwrap();

        let outcome = reclaim_pool_slots_at(&pools, &PoolLiveness::default(), 8).await;
        assert_eq!(
            outcome.evicted,
            vec![slot.clone()],
            "a resting tree is reclaimed outside the warm budget"
        );
        assert!(!tree.exists());
        let record = rehydrate_record_for_session_at(&layout, "rh1")
            .await
            .unwrap()
            .expect("the reclaimed session is recorded");
        assert_eq!(record.slot_id, slot);
        assert_eq!(record.instance_id, "inst-rh1");
        assert_eq!(record.branch.as_deref(), Some("feat/rest"));
        assert!(record.dirty_snapshot);

        // No new slot may take the recorded path.
        let manifest = load_manifest_at(layout.pool_root()).unwrap().unwrap();
        let reserved = layout
            .slot_component(&SlotId::parse(&slot).unwrap())
            .to_string();
        let mut offered = vec![SlotId::parse(&slot).unwrap()].into_iter();
        let fresh = allocate_slot_id(&layout, &manifest, || {
            offered.next().unwrap_or_else(SlotId::generate)
        })
        .unwrap();
        assert_ne!(layout.slot_component(&fresh).to_string(), reserved);

        // Another Instance cannot take the session's checkout.
        let mut stranger = req("rh1");
        stranger.instance_id = "inst-other".into();
        assert_eq!(
            rehydrate_retained_lease_at(&layout, &base, &record, &stranger)
                .await
                .unwrap_err()
                .code,
            PoolErrorCode::InvalidBinding
        );

        let successor = LeaseRequest {
            session_key: "rh1".into(),
            instance_id: "inst-rh1".into(),
            run_id: "run-rh1b".into(),
            execution_key: "exec-rh1b".into(),
        };
        let woken = rehydrate_retained_lease_at(&layout, &base, &record, &successor)
            .await
            .unwrap();
        assert_eq!(
            woken.worktree_path, tree,
            "the session wakes at the path its transcript names"
        );
        assert_eq!(state_of(&layout, &slot), SlotState::Starting);
        let branch = git_cmd()
            .args([
                "-C",
                tree.to_str().unwrap(),
                "symbolic-ref",
                "--short",
                "HEAD",
            ])
            .output()
            .unwrap();
        assert_eq!(
            String::from_utf8(branch.stdout).unwrap().trim(),
            "feat/rest"
        );
        assert_eq!(
            // Git may check text out with CRLF (Windows autocrlf).
            std::fs::read_to_string(tree.join("landed.txt"))
                .unwrap()
                .replace("\r\n", "\n"),
            "committed\n"
        );
        assert_eq!(
            // Git may check text out with CRLF (Windows autocrlf).
            std::fs::read_to_string(tree.join("draft.txt"))
                .unwrap()
                .replace("\r\n", "\n"),
            "uncommitted\n"
        );
        let status = git_cmd()
            .args(["-C", tree.to_str().unwrap(), "status", "--porcelain"])
            .output()
            .unwrap();
        assert!(
            String::from_utf8(status.stdout)
                .unwrap()
                .contains("?? draft.txt"),
            "the dirty tree is uncommitted again, not a snapshot commit"
        );
        assert!(
            rehydrate_record_for_session_at(&layout, "rh1")
                .await
                .unwrap()
                .is_none()
        );

        cleanup_test_dirs(&[&base, &remote, &pools]);
    }

    fn replacement_for(record: &RehydrateRecord) -> LeaseRequest {
        LeaseRequest {
            session_key: record.session_key.clone(),
            instance_id: record.instance_id.clone(),
            run_id: format!("{}-reborn", record.run_id),
            execution_key: format!("{}-reborn", record.execution_key),
        }
    }

    /// A resting session on `feat/lost` with one unpushed commit.
    async fn resting_session_with_commit(
        layout: &RepoPoolLayout,
        base: &Path,
        identity_url: &str,
        session: &str,
    ) -> (LeaseResult, String) {
        let lease = lease_available_or_create_at(layout, base, identity_url, &req(session))
            .await
            .unwrap();
        let tree = lease.worktree_path.clone();
        commit_unpushed_work(&tree, "feat/lost");
        let head = git_cmd()
            .args(["-C", tree.to_str().unwrap(), "rev-parse", "HEAD"])
            .output()
            .unwrap();
        mark_retained_at(layout, &req(session)).await.unwrap();
        (
            lease,
            String::from_utf8(head.stdout).unwrap().trim().to_string(),
        )
    }

    fn current_branch(tree: &Path) -> String {
        let out = git_cmd()
            .args([
                "-C",
                tree.to_str().unwrap(),
                "symbolic-ref",
                "--short",
                "HEAD",
            ])
            .output()
            .unwrap();
        String::from_utf8(out.stdout).unwrap().trim().to_string()
    }

    #[tokio::test]
    async fn a_retained_checkout_deleted_outside_the_pool_is_reborn_in_place() {
        if !git_available() {
            return;
        }
        let identity_url = "https://github.com/acme/lost-deleted";
        let (base, remote) = setup_base_with_local_fetch(identity_url);
        let pools = unique_temp("ld");
        let layout = layout_for(identity_url, &pools);
        let (lease, head) = resting_session_with_commit(&layout, &base, identity_url, "ld1").await;
        let tree = lease.worktree_path.clone();
        std::fs::remove_dir_all(&tree).unwrap();

        assert!(
            record_lost_retained_checkout_at(&layout, &base, "ld1")
                .await
                .unwrap()
        );
        let record = rehydrate_record_for_session_at(&layout, "ld1")
            .await
            .unwrap()
            .expect("the lost session is recorded");
        assert_eq!(record.slot_id, lease.slot_id.as_str());
        assert_eq!(record.head_oid, head, "git's worktree entry names its HEAD");
        assert_eq!(record.branch.as_deref(), Some("feat/lost"));
        assert!(!record.dirty_snapshot);

        rehydrate_at_original_path(&layout, &base, &record, &tree).await;
        assert_eq!(
            std::fs::read_to_string(tree.join("landed.txt"))
                .unwrap()
                .replace("\r\n", "\n"),
            "committed\n"
        );
        verify_pool_worktree_ownership(&layout, &base, &tree, &lease.slot_id)
            .await
            .expect("the recreated tree is a locked pool worktree again");

        // An intact tree is left alone.
        assert!(
            !record_lost_retained_checkout_at(&layout, &base, "ld1")
                .await
                .unwrap()
        );

        cleanup_test_dirs(&[&base, &remote, &pools]);
    }

    #[tokio::test]
    async fn a_retained_checkout_left_as_residue_is_reborn_in_place() {
        if !git_available() {
            return;
        }
        let identity_url = "https://github.com/acme/lost-residue";
        let (base, remote) = setup_base_with_local_fetch(identity_url);
        let pools = unique_temp("lr");
        let layout = layout_for(identity_url, &pools);
        let (lease, head) = resting_session_with_commit(&layout, &base, identity_url, "lr1").await;
        let tree = lease.worktree_path.clone();
        // A half-finished delete: the link to git is gone, files remain.
        std::fs::remove_file(tree.join(".git")).unwrap();
        std::fs::write(tree.join("stray.txt"), "residue\n").unwrap();

        assert!(
            record_lost_retained_checkout_at(&layout, &base, "lr1")
                .await
                .unwrap()
        );
        assert!(!tree.exists(), "residue is cleared for the recreated tree");
        let record = rehydrate_record_for_session_at(&layout, "lr1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(record.head_oid, head);
        rehydrate_at_original_path(&layout, &base, &record, &tree).await;
        assert!(tree.join("landed.txt").is_file());

        cleanup_test_dirs(&[&base, &remote, &pools]);
    }

    #[tokio::test]
    async fn the_sweep_records_a_lost_retained_checkout_instead_of_forgetting_it() {
        if !git_available() {
            return;
        }
        let identity_url = "https://github.com/acme/lost-sweep";
        let (base, remote) = setup_base_with_local_fetch(identity_url);
        let pools = unique_temp("ls");
        let layout = layout_for(identity_url, &pools);
        let (lease, head) = resting_session_with_commit(&layout, &base, identity_url, "ls1").await;
        let slot = lease.slot_id.as_str().to_string();
        assert_missing_checkout_pruned(&pools, &lease.worktree_path, &slot).await;
        let record = rehydrate_record_for_session_at(&layout, "ls1")
            .await
            .unwrap()
            .expect("the sweep keeps the session wakeable");
        assert_eq!(record.slot_id, slot);
        assert_eq!(record.head_oid, head);

        cleanup_test_dirs(&[&base, &remote, &pools]);
    }

    #[test]
    fn a_lost_checkout_is_found_by_its_pool_lock_or_its_path() {
        let porcelain = "worktree /repo\nHEAD 1111111111111111111111111111111111111111\nbranch refs/heads/main\n\n\
worktree /pools/a\nHEAD 2222222222222222222222222222222222222222\nbranch refs/heads/feat/x\nlocked xmatrix-pool:k/a\nprunable gitdir file points to non-existent location\n\n\
worktree /pools/b\nHEAD 3333333333333333333333333333333333333333\ndetached\n";
        assert_eq!(
            parse_lost_checkout_head(porcelain, "xmatrix-pool:k/a", Path::new("/elsewhere")),
            Some(LostCheckoutHead {
                head_oid: "2".repeat(40),
                branch: Some("feat/x".into()),
            })
        );
        assert_eq!(
            parse_lost_checkout_head(porcelain, "xmatrix-pool:k/b", Path::new("/pools/b")),
            Some(LostCheckoutHead {
                head_oid: "3".repeat(40),
                branch: None,
            })
        );
        assert_eq!(
            parse_lost_checkout_head(porcelain, "xmatrix-pool:k/c", Path::new("/pools/c")),
            None
        );
    }

    #[tokio::test]
    async fn new_repo_lease_discards_available_slot_missing_git_file() {
        if !git_available() {
            return;
        }
        let identity_url = "https://github.com/acme/missing-git";
        let (base, remote) = setup_base_with_local_fetch(identity_url);
        let pools = unique_temp("mg");
        let layout = layout_for(identity_url, &pools);
        let first = lease_available_or_create_at(&layout, &base, identity_url, &req("mg1"))
            .await
            .unwrap();
        return_abandoned_slot_at(&layout, &base, &req("mg1"))
            .await
            .unwrap();
        let leftover = first.worktree_path.clone();
        std::fs::remove_file(leftover.join(".git")).unwrap();

        let second = lease_available_or_create_at(&layout, &base, identity_url, &req("mg2"))
            .await
            .expect("a new owner/repo lease must not fail closed on leftover cache");
        assert_ne!(first.slot_id.as_str(), second.slot_id.as_str());
        assert!(second.worktree_path.join(".git").is_file());
        assert!(
            !leftover.exists(),
            "managed leftover slot directory must be removed"
        );
        let manifest = load_manifest_at(layout.pool_root()).unwrap().unwrap();
        assert!(
            !manifest.slots.contains_key(first.slot_id.as_str()),
            "broken idle slot must be dropped from the pool manifest"
        );
        assert!(manifest.slots.contains_key(second.slot_id.as_str()));

        cleanup_test_dirs(&[&base, &remote, &pools]);
    }

    #[tokio::test]
    async fn new_repo_lease_records_a_lost_retained_slot_before_clearing_it() {
        if !git_available() {
            return;
        }
        // The retained session is cold, so its broken tree is fair game.
        let _floors = NoIdleFloors::enter();
        let identity_url = "https://github.com/acme/missing-git-retained";
        let (base, remote) = setup_base_with_local_fetch(identity_url);
        let pools = unique_temp("mr");
        let layout = layout_for(identity_url, &pools);
        let first = lease_available_or_create_at(&layout, &base, identity_url, &req("mr1"))
            .await
            .unwrap();
        mark_retained_at(&layout, &req("mr1")).await.unwrap();
        let leftover = first.worktree_path.clone();
        std::fs::remove_file(leftover.join(".git")).unwrap();

        let expected = authority_for(&req("mr1"), &first.slot_id);
        let replacement = LeaseRequest {
            session_key: "mr1".into(),
            instance_id: "inst-mr1b".into(),
            run_id: "run-mr1b".into(),
            execution_key: "exec-mr1b".into(),
        };
        let reborn_err = rebind_retained_lease_at(&layout, &base, &expected, &replacement)
            .await
            .unwrap_err();
        assert_eq!(reborn_err.code, PoolErrorCode::WorktreeMissing);
        let after_reborn = load_manifest_at(layout.pool_root()).unwrap().unwrap();
        assert_eq!(
            after_reborn
                .slots
                .get(first.slot_id.as_str())
                .unwrap()
                .state,
            SlotState::Retained,
            "exact reborn must fail closed without deleting the missing tree"
        );

        let second = lease_available_or_create_at(&layout, &base, identity_url, &req("mr2"))
            .await
            .expect("a later new lease must clear the broken retained cache");
        assert_ne!(first.slot_id.as_str(), second.slot_id.as_str());
        assert!(second.worktree_path.join(".git").is_file());
        assert!(!leftover.exists());
        let manifest = load_manifest_at(layout.pool_root()).unwrap().unwrap();
        assert!(!manifest.slots.contains_key(first.slot_id.as_str()));
        assert!(manifest.slots.contains_key(second.slot_id.as_str()));
        // The resting session can still wake: its checkout was recorded first.
        let record = rehydrate_record_for_session_at(&layout, "mr1")
            .await
            .unwrap()
            .expect("the lost session is recorded for rehydrate");
        assert_eq!(record.slot_id, first.slot_id.as_str());
        let woken = rehydrate_retained_lease_at(&layout, &base, &record, &replacement_for(&record))
            .await
            .unwrap();
        assert_eq!(woken.worktree_path, leftover);

        cleanup_test_dirs(&[&base, &remote, &pools]);
    }

    #[test]
    fn ls_remote_symref_names_the_default_branch_and_its_tip() {
        let oid = "0123456789abcdef0123456789abcdef01234567";
        assert_eq!(
            parse_ls_remote_head(&format!("ref: refs/heads/main\tHEAD\n{oid}\tHEAD\n")),
            Some(("main".to_string(), oid.to_string()))
        );
        assert_eq!(
            parse_ls_remote_head(&format!("ref: refs/heads/release/1.2  HEAD\n{oid}\tHEAD\n"))
                .map(|(branch, _)| branch),
            Some("release/1.2".to_string())
        );
        // Detached remote HEAD, a symref without a tip, and unsafe names name nothing.
        assert_eq!(parse_ls_remote_head(&format!("{oid}\tHEAD\n")), None);
        assert_eq!(parse_ls_remote_head("ref: refs/heads/main\tHEAD\n"), None);
        assert_eq!(
            parse_ls_remote_head(&format!("ref: refs/heads/../../etc/passwd\tHEAD\n{oid}\tHEAD\n")),
            None
        );
    }

    fn commit_on_remote(remote: &Path, parent: &str, message: &str) -> String {
        let out = git_cmd()
            .arg("-C")
            .arg(remote)
            .args(["-c", "user.name=Test", "-c", "user.email=t@t", "commit-tree",
                &format!("{parent}^{{tree}}"), "-p", parent, "-m", message])
            .output()
            .unwrap();
        assert!(out.status.success());
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn rev(path: &Path, reference: &str) -> String {
        let out = git_cmd().arg("-C").arg(path).args(["rev-parse", reference]).output().unwrap();
        assert!(out.status.success(), "rev-parse {reference}");
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    #[tokio::test]
    async fn every_lease_confirms_origin_again() {
        if !git_available() {
            return;
        }
        let identity_url = "https://github.com/acme/fetch-confirm.git";
        let (base, remote) = setup_base_with_local_fetch(identity_url);
        let pools = unique_temp("fs");
        let layout = layout_for(identity_url, &pools);
        let _ = take_required_fetch_perform_count(&base);
        let first = lease_available_or_create_at(&layout, &base, identity_url, &req("fs1"))
            .await
            .unwrap();
        // Merged right after the first lease: the very next lease must see it.
        let merged = commit_on_remote(&remote, "main", "merged");
        run_git(&remote, &["update-ref", "refs/heads/main", &merged]);
        let second = lease_available_or_create_at(&layout, &base, identity_url, &req("fs2"))
            .await
            .unwrap();
        assert_eq!(take_required_fetch_perform_count(&base), 2, "each lease asks origin");
        assert_eq!(rev(&second.worktree_path, "HEAD"), merged);
        assert_ne!(rev(&first.worktree_path, "HEAD"), merged);
        cleanup_test_dirs(&[&pools, &base, &remote]);
    }

    /// Origin renames its default branch from `main` to `trunk`; the checkout
    /// still notes `origin/HEAD -> origin/main`.
    #[tokio::test]
    async fn lease_follows_origin_default_branch_switch() {
        if !git_available() {
            return;
        }
        // (old branch deleted, stale origin/trunk already known)
        for (delete_old, stale_new) in [(false, false), (true, false), (false, true)] {
            let identity_url = "https://github.com/acme/default-switch.git";
            let (base, remote) = setup_base_with_local_fetch(identity_url);
            let pools = unique_temp("ds");
            let layout = layout_for(identity_url, &pools);
            let first = rev(&remote, "main");
            if stale_new {
                run_git(&remote, &["update-ref", "refs/heads/trunk", &first]);
                run_git(&base, &["fetch", "-q", "origin", "+refs/heads/trunk:refs/remotes/origin/trunk"]);
            }
            let trunk = commit_on_remote(&remote, &first, "trunk tip");
            run_git(&remote, &["update-ref", "refs/heads/trunk", &trunk]);
            let main_tip = commit_on_remote(&remote, &first, "main moved on");
            run_git(&remote, &["update-ref", "refs/heads/main", &main_tip]);
            run_git(&remote, &["symbolic-ref", "HEAD", "refs/heads/trunk"]);
            if delete_old {
                run_git(&remote, &["update-ref", "-d", "refs/heads/main"]);
            }
            assert_eq!(rev(&base, "origin/HEAD"), first, "local note is stale");
            let lease = lease_available_or_create_at(&layout, &base, identity_url, &req("ds1"))
                .await
                .unwrap_or_else(|error| panic!("delete_old={delete_old} stale_new={stale_new}: {error}"));
            assert_eq!(lease.base_ref, "origin/trunk");
            assert_eq!(rev(&lease.worktree_path, "HEAD"), trunk);
            assert_eq!(rev(&base, "origin/HEAD"), trunk, "local note follows origin");
            cleanup_test_dirs(&[&pools, &base, &remote]);
        }
    }

    #[tokio::test]
    async fn origin_without_a_default_branch_fails_without_a_stale_base() {
        if !git_available() {
            return;
        }
        let identity_url = "https://github.com/acme/no-default.git";
        let (base, remote) = setup_base_with_local_fetch(identity_url);
        let pools = unique_temp("nd");
        let layout = layout_for(identity_url, &pools);
        // Origin's HEAD names a branch that does not exist; origin/main is still cached locally.
        run_git(&remote, &["symbolic-ref", "HEAD", "refs/heads/gone"]);
        let error = lease_available_or_create_at(&layout, &base, identity_url, &req("nd1"))
            .await
            .expect_err("no confirmed default branch, no lease");
        assert_eq!(error.code, PoolErrorCode::BaseRefUnresolved, "{error}");
        cleanup_test_dirs(&[&pools, &base, &remote]);
    }

    #[tokio::test]
    async fn concurrent_required_fetches_single_flight() {
        if !git_available() {
            return;
        }
        let identity_url = "https://github.com/acme/fetch-join.git";
        let (base, remote) = setup_base_with_local_fetch(identity_url);
        let _ = take_required_fetch_perform_count(&base);
        let left = required_fetch_and_resolve(&base);
        let right = required_fetch_and_resolve(&base);
        let (a, b) = tokio::join!(left, right);
        let a = a.expect("left fetch");
        let b = b.expect("right fetch");
        assert_eq!(a.oid, b.oid);
        assert_eq!(a.base_ref, b.base_ref);
        assert_eq!(
            take_required_fetch_perform_count(&base),
            1,
            "two waiters must share one origin fetch"
        );
        cleanup_test_dirs(&[&base, &remote]);
    }

    #[test]
    fn git_failures_are_classified_without_raw_stderr() {
        assert_eq!(
            classify_git_failure(
                "fatal: Unable to create '/repo/.git/refs/remotes/origin/main.lock': File exists."
            ),
            GitRunError::Lock
        );
        assert_eq!(
            classify_git_failure("error: cannot lock ref 'refs/remotes/origin/main'"),
            GitRunError::Lock
        );
        assert_eq!(
            classify_git_failure(
                "fatal: Authentication failed for 'https://github.com/acme/repo.git/'"
            ),
            GitRunError::Auth
        );
        assert_eq!(
            classify_git_failure(
                "fatal: could not read Username for 'https://github.com': terminal prompts disabled"
            ),
            GitRunError::Auth
        );
        assert_eq!(
            classify_git_failure(
                "fatal: unable to access 'https://github.com/acme/repo.git/': Could not resolve host"
            ),
            GitRunError::Network
        );
        for stderr in [
            "fatal: unable to access 'https://github.com/acme/repo.git/': Failed to connect to github.com port 443 after 75003 ms: Couldn't connect to server",
            "error: RPC failed; curl 56 GnuTLS recv error (-54): Error in the pull function.\nfatal: early EOF",
            "fatal: unable to access 'https://github.com/acme/repo.git/': OpenSSL SSL_read: SSL_ERROR_SYSCALL, errno 54",
        ] {
            assert_eq!(classify_git_failure(stderr), GitRunError::Network, "{stderr}");
        }
        assert_eq!(
            classify_git_failure(
                "fatal: unable to access 'https://github.com/acme/repo.git/': The requested URL returned error: 403"
            ),
            GitRunError::Auth
        );
        // Worktree-add shaped failures: "unable to create" must not be misread as lock contention.
        assert_eq!(
            classify_git_failure(
                "error: unable to create file src/very/deep/path.rs: Filename too long"
            ),
            GitRunError::PathTooLong
        );
        assert_eq!(
            classify_git_failure(
                "fatal: unable to create '/pool/slots/abc/.git': No space left on device"
            ),
            GitRunError::DiskFull
        );
        assert_eq!(
            classify_git_failure(
                "fatal: could not create leading directories of '/pool/slots/abc': Permission denied"
            ),
            GitRunError::PermissionDenied
        );
        assert_eq!(
            classify_git_failure("git@github.com: Permission denied (publickey)."),
            GitRunError::Auth
        );
        assert_eq!(
            classify_git_failure("fatal: '/pool/slots/abc' already exists"),
            GitRunError::PathExists
        );
        assert_eq!(
            classify_git_failure(
                "fatal: '/pool/slots/abc' is a missing but already registered worktree;\nuse 'add -f' to override, or 'prune' or 'remove' to clear"
            ),
            GitRunError::PathExists
        );
        assert_eq!(
            classify_git_failure("fatal: invalid reference: origin/main"),
            GitRunError::RefUnresolved
        );
        assert_eq!(GitRunError::PathTooLong.as_str(), "path too long");
        assert_eq!(GitRunError::Failed.as_str(), "git command failed");
        for stderr in [
            "remote: Repository not found.\nfatal: repository 'https://github.com/acme/gone.git/' not found",
            "fatal: unable to access 'https://github.com/acme/gone.git/': The requested URL returned error: 404",
        ] {
            assert_eq!(classify_git_failure(stderr), GitRunError::NotFound, "{stderr}");
        }
    }

    #[test]
    fn a_refused_space_credential_is_a_repository_access_failure() {
        for error in [GitRunError::Auth, GitRunError::NotFound] {
            let refused = required_fetch_error(error.into(), true);
            assert_eq!(refused.code, PoolErrorCode::FetchRequiredFailed);
            assert!(
                refused.to_string().starts_with("fetch_required_failed: repository_access_unavailable: "),
                "{refused}"
            );
            // The host's own login refusing is not the Space connection's answer.
            assert!(!required_fetch_error(error.into(), false).to_string().contains("repository_access_unavailable"));
        }
        assert!(!required_fetch_error(GitRunError::Network.into(), true).to_string().contains("repository_access_unavailable"));
    }

    #[tokio::test]
    async fn rejected_fetch_preserves_git_stderr() {
        if !git_available() { return; }
        let (base, remote) = setup_base_with_local_fetch("https://github.com/acme/rejected-fetch");
        // The tracking ref has a local-only descendant; fetching the remote
        // branch back to its ancestor must fail without any forced ref update.
        run_git(&base, &["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "local-only"]);
        run_git(&base, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
        // Deliberately request an unforced fetch to keep real-Git diagnostic coverage.
        let failure = git(&base, &["fetch", "--no-tags", "origin",
            "refs/heads/main:refs/remotes/origin/main"], GIT_FETCH_TIMEOUT).await.unwrap_err();
        let error = required_fetch_error(failure, false);
        assert_eq!(error.code, PoolErrorCode::FetchRequiredFailed);
        assert!(error.message.contains("[rejected]"), "{error}");
        assert!(error.message.contains("non-fast-forward"), "{error}");
        assert!(!error.message.contains("git command failed"), "{error}");
        cleanup_test_dirs(&[&base, &remote]);
    }

    #[tokio::test]
    async fn lease_follows_rewritten_origin_without_changing_local_work() {
        if !git_available() { return; }
        for unrelated in [false, true] {
            let identity = "https://github.com/acme/rewritten-origin";
            let (base, remote) = setup_base_with_local_fetch(identity);
            let pools = unique_temp("rewrite");
            let layout = layout_for(identity, &pools);
            let original = git(&base, &["rev-parse", "HEAD"], GIT_LOCAL_TIMEOUT).await.unwrap();
            let active = lease_available_or_create_at(&layout, &base, identity, &req("active"))
                .await.unwrap();
            let original_content = std::fs::read_to_string(active.worktree_path.join("README.md")).unwrap();
            std::fs::write(active.worktree_path.join("README.md"), "active work\n").unwrap();
            run_git(&base, &["commit", "--allow-empty", "-qm", "local-only"]);
            let local = git(&base, &["rev-parse", "HEAD"], GIT_LOCAL_TIMEOUT).await.unwrap();
            run_git(&base, &["update-ref", "refs/remotes/origin/main", &local]);
            std::fs::write(base.join("README.md"), "local work\n").unwrap();
            let target = if unrelated {
                git(&remote, &["-c", "user.name=Test", "-c", "user.email=t@t",
                    "commit-tree", "main^{tree}", "-m", "replacement root"], GIT_LOCAL_TIMEOUT)
                    .await.unwrap()
            } else { original.clone() };
            run_git(&remote, &["update-ref", "refs/heads/main", &target]);
            let fresh = lease_available_or_create_at(&layout, &base, identity, &req("fresh"))
                .await.unwrap();
            for (path, reference, expected) in [
                (&base, "origin/main", &target), (&base, "HEAD", &local),
                (&active.worktree_path, "HEAD", &original),
                (&fresh.worktree_path, "HEAD", &target),
            ] {
                assert_eq!(git(path, &["rev-parse", reference], GIT_LOCAL_TIMEOUT).await.unwrap(), *expected);
            }
            assert_eq!(std::fs::read_to_string(base.join("README.md")).unwrap(), "local work\n");
            assert_eq!(std::fs::read_to_string(active.worktree_path.join("README.md")).unwrap(), "active work\n");
            assert_eq!(std::fs::read_to_string(fresh.worktree_path.join("README.md")).unwrap(), original_content);
            cleanup_test_dirs(&[&pools, &base, &remote]);
        }
    }

    #[test]
    fn stderr_redacts_every_secret_without_losing_later_failure_lines() {
        let raw = "From https://u:first@github.com/a/b?token=second\nremote: https://u:third@github.com/c/d\nfatal: password=fourth token=fifth ghp_sixth\n ! [rejected] main -> origin/main (non-fast-forward)";
        let error = required_fetch_error(GitCommandError::new(GitRunError::Failed, raw), false);
        for secret in ["first", "second", "third", "fourth", "fifth", "ghp_sixth"] {
            assert!(!error.message.contains(secret), "{error}");
        }
        assert!(error.message.contains("non-fast-forward"), "{error}");
    }

    #[tokio::test]
    async fn worktree_add_failure_reports_git_classification() {
        if !git_available() {
            return;
        }
        let base = unique_temp("wt-add-classified");
        std::fs::create_dir_all(&base).unwrap();
        run_git(&base, &["init", "-q", "-b", "main"]);
        std::fs::write(base.join("f.txt"), "x").unwrap();
        run_git(&base, &["add", "."]);
        run_git(
            &base,
            &[
                "-c",
                "user.email=t@t",
                "-c",
                "user.name=t",
                "commit",
                "-qm",
                "init",
            ],
        );
        let oid = git_cmd()
            .arg("-C")
            .arg(&base)
            .args(["rev-parse", "HEAD"])
            .output()
            .unwrap();
        let oid = String::from_utf8_lossy(&oid.stdout).trim().to_string();
        let fetched = ResolvedBase {
            base_ref: "main".to_string(),
            oid,
            confirmed_at: now_rfc3339(),
            history_rewritten: None,
        };
        // Occupy the target path with a plain directory so `git worktree add` refuses it.
        let occupied = base.join("occupied");
        std::fs::create_dir_all(occupied.join("something")).unwrap();
        let err = create_linked_slot_required_fetch(&base, &occupied, &fetched)
            .await
            .expect_err("worktree add into an occupied path must fail");
        assert_eq!(err.code, PoolErrorCode::WorktreeCreateFailed);
        assert!(err.message.contains("already exists"), "{err}");
        assert!(err.message.contains("fatal:"), "{err}");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn lease_pins_base_and_ignores_later_workspace_checkout() {
        if !git_available() {
            return;
        }
        let identity_url = "https://github.com/acme/pin-base";
        let (base, remote) = setup_base_with_local_fetch(identity_url);
        let (workspace, workspace_remote) = setup_base_with_local_fetch(identity_url);
        // Distinct HEAD so a workspace-local fetch cannot be checked out in
        // the pinned parent's object store (Windows commits are rarely same-second).
        std::fs::write(workspace.join("README.md"), "workspace-distinct\n").unwrap();
        run_git(&workspace, &["add", "README.md"]);
        run_git(
            &workspace,
            &["commit", "--quiet", "-m", "workspace diverge"],
        );
        let pools = unique_temp("pin");
        let layout = layout_for(identity_url, &pools);
        let first = lease_available_or_create_at(&layout, &base, identity_url, &req("pin1"))
            .await
            .unwrap();
        return_abandoned_slot_at(&layout, &base, &req("pin1"))
            .await
            .unwrap();

        let second = lease_available_or_create_at(&layout, &workspace, identity_url, &req("pin2"))
            .await
            .unwrap();
        assert_eq!(first.slot_id.as_str(), second.slot_id.as_str());
        assert_pool_tree_owned(&layout, &base, &second).await;
        let manifest = load_manifest_at(layout.pool_root()).unwrap().unwrap();
        let pinned = PathBuf::from(manifest.base_repo_path.expect("pin recorded"));
        assert!(paths_equal_platform(
            &canonicalize_pool_base_path(&pinned).unwrap(),
            &canonicalize_pool_base_path(&base).unwrap()
        ));

        cleanup_test_dirs(&[&base, &remote, &workspace, &workspace_remote, &pools]);
    }

    #[tokio::test]
    async fn new_lease_discards_idle_foreign_parent_slot() {
        if !git_available() {
            return;
        }
        let identity_url = "https://github.com/acme/foreign-parent";
        let (base, remote) = setup_base_with_local_fetch(identity_url);
        let (other_base, other_remote) = setup_base_with_local_fetch(identity_url);
        let pools = unique_temp("fp");
        let layout = layout_for(identity_url, &pools);
        let first = lease_available_or_create_at(&layout, &base, identity_url, &req("fp1"))
            .await
            .unwrap();
        return_abandoned_slot_at(&layout, &base, &req("fp1"))
            .await
            .unwrap();
        let path = first.worktree_path.clone();
        replace_with_foreign_worktree(&base, &other_base, &path).await;

        let second = lease_available_or_create_at(&layout, &base, identity_url, &req("fp2"))
            .await
            .expect("foreign-parent idle slot must not fail the lease");
        assert_ne!(first.slot_id.as_str(), second.slot_id.as_str());
        assert_pool_tree_owned(&layout, &base, &second).await;
        let manifest = load_manifest_at(layout.pool_root()).unwrap().unwrap();
        assert!(!manifest.slots.contains_key(first.slot_id.as_str()));
        assert!(
            !path.exists() || !path.join(".git").is_file(),
            "foreign-parent leftover must be detached"
        );

        cleanup_test_dirs(&[&base, &remote, &other_base, &other_remote, &pools]);
    }

    #[tokio::test]
    async fn quarantined_verify_failed_slot_is_readmitted_when_parent_matches() {
        if !git_available() {
            return;
        }
        let identity_url = "https://github.com/acme/readmit";
        let (base, remote) = setup_base_with_local_fetch(identity_url);
        let pools = unique_temp("ra");
        let layout = layout_for(identity_url, &pools);
        let first = lease_available_or_create_at(&layout, &base, identity_url, &req("ra1"))
            .await
            .unwrap();
        return_abandoned_slot_at(&layout, &base, &req("ra1"))
            .await
            .unwrap();
        let mut manifest = load_manifest_at(layout.pool_root()).unwrap().unwrap();
        let slot = manifest.slots.get_mut(first.slot_id.as_str()).unwrap();
        slot.state = SlotState::Quarantined;
        slot.quarantine_code = Some(PoolErrorCode::VerifyFailed);
        save_manifest_at(layout.pool_root(), &manifest).unwrap();

        let second = lease_available_or_create_at(&layout, &base, identity_url, &req("ra2"))
            .await
            .unwrap();
        assert_eq!(first.slot_id.as_str(), second.slot_id.as_str());
        let manifest = load_manifest_at(layout.pool_root()).unwrap().unwrap();
        let slot = manifest.slots.get(first.slot_id.as_str()).unwrap();
        assert_eq!(slot.state, SlotState::Starting);
        assert_eq!(slot.quarantine_code, None);

        cleanup_test_dirs(&[&base, &remote, &pools]);
    }

    /// A reborn whose Hub carried no pool authority must still find the exact
    /// slot this machine retained for its session -- the only cwd its harness
    /// session can resume in -- and must fail, not fall back, when that slot
    /// cannot be reborn.
    #[tokio::test]
    async fn unissued_reborn_finds_the_session_retained_slot_or_fails_closed() {
        if !git_available() {
            return;
        }
        let identity_url = "https://github.com/acme/unissued";
        let identity = canonical_repo_identity(identity_url).unwrap();
        let key = repo_key_id(&identity);
        let pools = unique_temp("ur");
        // A machine that never pooled this repo keeps the historical path.
        assert!(
            retained_binding_for_unissued_reborn_at(&pools, &key, "ur1")
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            std::fs::read_dir(&pools).unwrap().next().is_none(),
            "the lookup must not create a pool for an unpooled repo"
        );

        let (base, remote) = setup_base_with_local_fetch(identity_url);
        let layout = layout_for(identity_url, &pools);
        let lease = lease_available_or_create_at(&layout, &base, identity_url, &req("ur1"))
            .await
            .unwrap();
        let live = authority_for(&req("ur1"), &lease.slot_id);
        claim_starting_lease_at(
            &layout,
            &live,
            &lease.spawn_claim_token,
            &lease.worktree_path,
        )
        .await
        .unwrap();
        // A session this machine never bound is not this reborn's business.
        assert!(
            retained_binding_for_unissued_reborn_at(&pools, &key, "someone-else")
                .await
                .unwrap()
                .is_none()
        );
        // Bound but still leased (the predecessor has not stopped): fail closed.
        assert_eq!(
            retained_binding_for_unissued_reborn_at(&pools, &key, "ur1")
                .await
                .unwrap_err()
                .code,
            PoolErrorCode::InvalidBinding
        );

        mark_retained_at(&layout, &req("ur1")).await.unwrap();
        let retained = retained_binding_for_unissued_reborn_at(&pools, &key, "ur1")
            .await
            .unwrap()
            .expect("the retained slot for this session");
        assert_eq!(retained.authority.slot_id, lease.slot_id.as_str());
        assert_eq!(retained.authority.instance_id, "inst-ur1");
        assert_eq!(retained.canonical_repo_identity, identity.as_str());
        // The authority it yields leases back the exact same directory.
        let reborn = LeaseRequest {
            session_key: "ur1".into(),
            instance_id: "inst-ur1".into(),
            run_id: "run-ur1-reborn".into(),
            execution_key: "exec-ur1-reborn".into(),
        };
        let rebound = rebind_retained_lease_at(&layout, &base, &retained.authority, &reborn)
            .await
            .unwrap();
        assert_eq!(rebound.worktree_path, lease.worktree_path);
        mark_retained_at(&layout, &reborn).await.unwrap();

        // The retained directory is gone: still this session's slot, which
        // the reborn recreates in place.
        std::fs::remove_dir_all(&lease.worktree_path).unwrap();
        let lost = retained_binding_for_unissued_reborn_at(&pools, &key, "ur1")
            .await
            .unwrap()
            .expect("a lost retained slot still answers");
        assert_eq!(lost.authority.slot_id, lease.slot_id.as_str());
        // Once recorded for rehydrate, the record answers instead.
        assert!(
            record_lost_retained_checkout_at(&layout, &base, "ur1")
                .await
                .unwrap()
        );
        let recorded = retained_binding_for_unissued_reborn_at(&pools, &key, "ur1")
            .await
            .unwrap()
            .expect("a recorded session still answers");
        assert_eq!(recorded.authority.slot_id, lease.slot_id.as_str());
        assert_eq!(recorded.authority.instance_id, "inst-ur1");

        cleanup_test_dirs(&[&base, &remote, &pools]);
    }

    include!("repo_pool_handoff_tests.rs");
}
