/// The branch checked out in `cwd`, or None when detached or unknown.
fn current_git_branch(cwd: &Path) -> Option<String> {
    let mut command =
        xmatrix_cli_workspace::git_probe_command(cwd, &["rev-parse", "--abbrev-ref", "HEAD"]);
    process_tree::configure_std_process_tree(&mut command);
    let mut child = command.spawn().ok()?;
    let mut process_tree = process_tree::guard_std_child(&mut child).ok()?;
    if !xmatrix_cli_workspace::wait_for_git_probe(
        &mut child,
        GIT_PROBE_TIMEOUT,
        |child, timed_out| {
            let _ = process_tree.terminate();
            let _ = child.kill();
            let _ = child.wait();
            if timed_out {
                eprintln!(
                    "{} git branch probe timed out after {}s in {}",
                    "⚠".yellow().bold(),
                    GIT_PROBE_TIMEOUT.as_secs(),
                    cwd.display()
                );
            }
        },
    ) {
        return None;
    }
    let output = child.wait_with_output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|branch| !branch.is_empty() && branch != "HEAD")
}
