//! `xmatrix star` stars a GitHub repository as the person at the keyboard.
//! GitHub forbids automated starring, so the command must not reach `gh` when
//! nobody is at a terminal, which is how every Agent runs it.

#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::process::{Command, Stdio};

#[test]
fn star_refuses_without_a_person_and_never_reaches_the_github_cli() {
    let dir = std::env::temp_dir().join(format!(
        "xmatrix-star-needs-a-person-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let called = dir.join("gh-was-called");
    let gh = dir.join("gh");
    std::fs::write(&gh, format!("#!/bin/sh\ntouch '{}'\n", called.display())).expect("fake gh");
    std::fs::set_permissions(&gh, std::fs::Permissions::from_mode(0o755)).expect("executable gh");

    // Piped stdio is what a test, a script and an Agent's shell tool all have.
    let output = Command::new(env!("CARGO_BIN_EXE_xmatrix"))
        .arg("star")
        .env("PATH", &dir)
        .env("HOME", &dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("xmatrix star should start");

    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        !output.status.success(),
        "xmatrix star succeeded without a person: {stderr}"
    );
    assert!(
        stderr.contains("interactive terminal") || stderr.contains("Agent runs cannot star"),
        "unexpected refusal: {stderr}"
    );
    let reached_gh = called.exists();
    let _ = std::fs::remove_dir_all(&dir);
    assert!(
        !reached_gh,
        "xmatrix star reached gh without a person at a terminal"
    );
}
