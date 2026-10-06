/// Best-effort cleanup in caller order; recovery tests often leave locked trees.
fn cleanup_test_dirs(paths: &[&std::path::Path]) {
    for path in paths {
        let _ = std::fs::remove_dir_all(path);
    }
}
