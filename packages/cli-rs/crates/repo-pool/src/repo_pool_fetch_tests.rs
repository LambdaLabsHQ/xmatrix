/// A real thin fetch cannot resolve a delta after a local base blob is lost.
/// Existing baseline tests only use complete object stores. Exercise recovery
/// at lease admission, including an older checkout with uncommitted work.
#[tokio::test]
async fn lease_recovers_missing_delta_bases_without_resetting_existing_work() {
    if !git_available() {
        return;
    }
    let identity = "https://github.com/acme/delta-recovery";
    let (base, remote) = setup_base_with_local_fetch(identity);
    let writer = unique_temp("writer");
    run_git(&writer, &["clone", "--quiet", &remote.display().to_string(), "."]);
    run_git(&writer, &["config", "user.name", "Test"]);
    run_git(&writer, &["config", "user.email", "test@example.com"]);
    let original: String = (0..3000)
        .map(|i| format!("{i:06} stable content that is unchanged between revisions\n"))
        .collect();
    std::fs::write(writer.join("payload.txt"), &original).unwrap();
    run_git(&writer, &["add", "."]);
    run_git(&writer, &["commit", "--quiet", "-m", "large delta base"]);
    run_git(&writer, &["push", "--quiet", "origin", "main"]);
    // Keep this blob loose so removing it cannot damage the remote fixture.
    run_git(&base, &["-c", "fetch.unpackLimit=999999", "fetch", "--quiet", "origin"]);
    let old_tip = rev(&base, "origin/main");
    let blob = rev(&base, "origin/main:payload.txt");
    let pools = unique_temp("pools");
    let layout = layout_for(identity, &pools);
    let older = lease_available_or_create_at(&layout, &base, identity, &req("old"))
        .await
        .unwrap();
    commit_unpushed_work(&older.worktree_path, "keep-local-work");
    let local_tip = rev(&older.worktree_path, "HEAD");
    std::fs::write(older.worktree_path.join("README.md"), "uncommitted work\n").unwrap();

    let updated = original.replace("001500 stable content", "001500 changed content");
    std::fs::write(writer.join("payload.txt"), &updated).unwrap();
    run_git(&writer, &["add", "."]);
    run_git(&writer, &["commit", "--quiet", "-m", "delta against lost blob"]);
    run_git(&writer, &["push", "--quiet", "origin", "main"]);
    let new_tip = rev(&writer, "HEAD");
    std::fs::remove_file(base.join(".git/objects").join(&blob[..2]).join(&blob[2..])).unwrap();
    // Use index-pack even for this small fixture, matching the production error.
    run_git(&base, &["config", "fetch.unpackLimit", "1"]);
    let failed = git(&base, &["fetch", "--no-tags", "origin",
        "+refs/heads/main:refs/remotes/origin/main"], GIT_FETCH_TIMEOUT)
        .await
        .expect_err("ordinary fetching must reproduce the missing delta base");
    assert!(failed.as_str().contains("unresolved delta"), "{failed:?}");
    assert_eq!(rev(&base, "origin/main"), old_tip);

    let recovered = lease_available_or_create_at(&layout, &base, identity, &req("new"))
        .await
        .expect("a lease repairs missing delta bases within the fetch retry budget");
    assert_eq!(rev(&recovered.worktree_path, "HEAD"), new_tip);
    assert_eq!(std::fs::read_to_string(recovered.worktree_path.join("payload.txt")).unwrap().replace("\r\n", "\n"), updated);
    assert_eq!(rev(&older.worktree_path, "HEAD"), local_tip);
    assert_eq!(current_branch(&older.worktree_path), "keep-local-work");
    assert_eq!(std::fs::read_to_string(older.worktree_path.join("README.md")).unwrap(), "uncommitted work\n");
    run_git(&base, &["fsck", "--full"]);
    cleanup_test_dirs(&[&base, &remote, &writer, &pools]);
}
