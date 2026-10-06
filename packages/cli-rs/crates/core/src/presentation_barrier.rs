//! A provider can execute tools before its stdout reader commits the first
//! native presentation. This Run-owned status gate orders CLI sends and carries
//! no model, effort, or other substitute for the Hub's presentation authority.

use std::path::{Path, PathBuf};
use std::time::Duration;

const SEND_WAIT: Duration = Duration::from_secs(30);

/// Older wrappers, other harnesses and missing markers require no wait.
/// Metadata timeout never vetoes a message or invents a presentation value.
pub async fn wait_for_current_presentation() {
    let Some(path) = std::env::var_os("XMATRIX_RUN_STATUS_FILE").map(PathBuf::from) else {
        return;
    };
    if !wait_for_path(&path, SEND_WAIT).await {
        eprintln!(
            "First native presentation is still pending; sending with the Hub's current snapshot"
        );
    }
}

pub async fn wait_for_path(path: &Path, budget: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + budget;
    loop {
        let pending = std::fs::read(path)
            .ok()
            .and_then(|raw| serde_json::from_slice::<serde_json::Value>(&raw).ok())
            .is_some_and(|marker| marker["presentationPending"] == true);
        if !pending {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep_until(std::cmp::min(
            deadline,
            tokio::time::Instant::now() + Duration::from_millis(20),
        ))
        .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn sends_wait_for_commit_but_legacy_unknown_and_timeout_remain_bounded() {
        let path = std::env::temp_dir().join(format!(
            "xmatrix-presentation-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&path, r#"{"presentationPending":true}"#).unwrap();
        let waiter_path = path.clone();
        let waiter =
            tokio::spawn(async move { wait_for_path(&waiter_path, Duration::from_secs(1)).await });
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert!(!waiter.is_finished());
        std::fs::write(&path, r#"{"presentationPending":false}"#).unwrap();
        assert!(waiter.await.unwrap());
        std::fs::write(&path, r#"{"presentationPending":true}"#).unwrap();
        assert!(!wait_for_path(&path, Duration::from_millis(20)).await);
        assert!(
            path.exists(),
            "the sending child never mutates its wrapper's marker"
        );
        std::fs::write(&path, r#"{"model":"observed-without-a-gate"}"#).unwrap();
        assert!(wait_for_path(&path, Duration::ZERO).await);
        std::fs::remove_file(&path).unwrap();
        assert!(wait_for_path(&path, Duration::ZERO).await);
    }
}
