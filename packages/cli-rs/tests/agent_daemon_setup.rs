//! Installation setup must obey the same Human boundary as the DaemonHost.
use std::process::Command;

#[test]
fn agent_setup_refuses_before_profile_admission_or_installation() {
    let dir = std::env::temp_dir().join(format!("xmatrix-agent-setup-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let sentinel = dir.join("untouched");
    std::fs::write(&sentinel, "existing installation").unwrap();
    for flag in ["XMATRIX_AGENT_SESSION", "XMATRIX_HEADLESS"] {
        for args in [
            vec!["setup", "daemon"],
            vec!["setup", "install", "--daemon"],
        ] {
            let output = Command::new(env!("CARGO_BIN_EXE_xmatrix"))
                .args(&args)
                .env_remove("XMATRIX_AGENT_SESSION")
                .env_remove("XMATRIX_HEADLESS")
                .env(flag, "1")
                .env("XMATRIX_CONFIG_DIR", &dir)
                // Deliberately unusable admission: setup must refuse even
                // before it considers the caller's routing or installation.
                .env("XMATRIX_RUN_PROFILE_ID", "profile:missing")
                .env("XMATRIX_HUB_URL", "not-a-hub")
                .output()
                .unwrap();
            let error = String::from_utf8_lossy(&output.stderr);
            assert!(!output.status.success());
            assert!(
                error.contains("Agent runs cannot configure the installation daemon host"),
                "{flag} {args:?} reached profile admission instead of refusing: {error}"
            );
            assert_eq!(
                std::fs::read_to_string(&sentinel).unwrap(),
                "existing installation"
            );
            assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        }
    }
    std::fs::remove_dir_all(dir).unwrap();
}
