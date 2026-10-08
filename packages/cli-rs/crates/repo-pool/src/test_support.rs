//! Git fixtures shared by this crate's tests.

use std::path::{Path, PathBuf};

pub(crate) fn unique_temp_dir(label: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "xmatrix-run-worktree-{label}-{}-{nanos}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

pub(crate) fn git_available() -> bool {
    std::process::Command::new("git")
        .arg("--version")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

// When these tests run under a git hook (pre-commit CI), git exports
// GIT_DIR/GIT_INDEX_FILE/GIT_WORK_TREE into the environment. Those
// override -C/cwd, so a fixture "git commit" would land in the REAL
// repository mid-commit. Always scrub them.
pub(crate) fn git_command() -> std::process::Command {
    let mut command = std::process::Command::new("git");
    command
        .env_remove("GIT_DIR")
        .env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_OBJECT_DIRECTORY")
        .env_remove("GIT_ALTERNATE_OBJECT_DIRECTORIES");
    command
}

pub(crate) fn run_git(cwd: &Path, args: &[&str]) {
    let status = git_command()
        .arg("-C")
        .arg(cwd)
        .args(args)
        // Git exports these variables to hooks. Without clearing them,
        // fixture commands run by the tracked pre-commit hook mutate the
        // caller's real worktree instead of the temporary test repo.
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .status()
        .unwrap();
    assert!(status.success(), "git {args:?} failed in {}", cwd.display());
}

pub(crate) fn run_git_no_cwd(args: &[&str]) {
    let status = git_command().args(args).status().unwrap();
    assert!(status.success(), "git {args:?} failed");
}

pub(crate) fn init_repo_with_commit(dir: &Path) {
    run_git(dir, &["init", "--quiet", "--initial-branch=main"]);
    run_git(dir, &["config", "user.email", "test@example.com"]);
    run_git(dir, &["config", "user.name", "Test"]);
    std::fs::write(dir.join("README.md"), "hello").unwrap();
    run_git(dir, &["add", "."]);
    run_git(dir, &["commit", "--quiet", "-m", "init"]);
}

pub(crate) fn seed_remote(remote: &Path, seed: &Path) -> String {
    run_git(
        remote,
        &["init", "--bare", "--quiet", "--initial-branch=main"],
    );
    init_repo_with_commit(seed);
    let remote_arg = remote.display().to_string();
    run_git(seed, &["remote", "add", "origin", &remote_arg]);
    run_git(seed, &["push", "--quiet", "-u", "origin", "main"]);
    remote_arg
}
