//! Configuration diagnostics must never export the stored login credentials.
use std::process::Command;

#[test]
fn config_redacts_whole_session_and_individual_credentials_without_changing_storage() {
    let dir =
        std::env::temp_dir().join(format!("xmatrix-config-diagnostics-{}", std::process::id()));
    let sessions = dir.join("sessions");
    std::fs::create_dir_all(&sessions).expect("session directory");
    let session = serde_json::json!({
        "token": "test-private-access-token",
        "refreshToken": "test-private-refresh-token",
        "user": {"id": "test-user", "email": "person@example.test", "name": "Test Person"},
        "hubUrl": "https://xmatrix-hub.xmatrix.sh",
        "relayUrl": "wss://xmatrix-hub.xmatrix.sh/ws/humans",
        "updatedAt": "1", "expiresAt": "9999999999"
    });
    let path = sessions.join("production.json");
    let stored = serde_json::to_vec(&session).unwrap();
    std::fs::write(&path, &stored).expect("store fixture session");
    for key in [
        None,
        Some("token"),
        Some("refreshToken"),
        Some("hubUrl"),
        Some("missing"),
    ] {
        let mut command = Command::new(env!("CARGO_BIN_EXE_xmatrix"));
        command
            .arg("--environment")
            .arg("production")
            .arg("config")
            .env("XMATRIX_CONFIG_DIR", &dir)
            .env_remove("XMATRIX_PROFILE")
            .env_remove("XMATRIX_RUN_PROFILE_ID")
            .env_remove("XMATRIX_AGENT_SESSION")
            .env_remove("XMATRIX_HEADLESS")
            .env_remove("XMATRIX_HUB_URL");
        if let Some(key) = key {
            command.arg(key);
        }
        let output = command.output().expect("config starts");
        assert!(
            output.status.success(),
            "config failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let stdout = String::from_utf8(output.stdout).unwrap();
        let stderr = String::from_utf8(output.stderr).unwrap();
        for secret in ["test-private-access-token", "test-private-refresh-token"] {
            assert!(
                !stdout.contains(secret) && !stderr.contains(secret),
                "config exposed a credential"
            );
        }
        match key {
            None => {
                let value: serde_json::Value = serde_json::from_str(&stdout).unwrap();
                assert_eq!(value["token"], "[redacted]");
                assert_eq!(value["refreshToken"], "[redacted]");
                assert_eq!(value["user"], session["user"]);
                assert_eq!(value["hubUrl"], session["hubUrl"]);
            }
            Some("token" | "refreshToken") => assert_eq!(stdout.trim(), "\"[redacted]\""),
            Some("hubUrl") => assert_eq!(stdout.trim(), "\"https://xmatrix-hub.xmatrix.sh\""),
            _ => assert!(stdout.contains("not found")),
        }
        assert_eq!(
            std::fs::read(&path).unwrap(),
            stored,
            "diagnostics mutated credentials"
        );
    }
    std::fs::remove_dir_all(dir).unwrap();
}
