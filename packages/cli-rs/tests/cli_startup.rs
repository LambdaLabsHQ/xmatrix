use std::process::Command;

#[test]
fn cli_help_starts_without_overflowing_the_platform_stack() {
    // Force plain help text: clap may inject ANSI SGR around the binary name
    // when a color terminal is detected, which breaks exact "Usage: xmatrix"
    // substring matches on Windows.
    let output = Command::new(env!("CARGO_BIN_EXE_xmatrix"))
        .env("NO_COLOR", "1")
        .env("CLICOLOR", "0")
        .env_remove("CLICOLOR_FORCE")
        .env_remove("FORCE_COLOR")
        .arg("--help")
        .output()
        .expect("xmatrix --help should start");

    assert!(
        output.status.success(),
        "xmatrix --help failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("Usage:") && stdout.contains("xmatrix"),
        "unexpected --help stdout: {stdout}"
    );
}
