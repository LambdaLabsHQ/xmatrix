//! Results of daemon commands that Hub has not confirmed yet.
//!
//! Hub decides whether a command runs: every execution passes its admission.
//! The daemon keeps one thing of its own, the result of a command it finished
//! and Hub has not acknowledged, so a redelivery answers with that result
//! instead of doing the work again. One file per command, removed when Hub
//! confirms it. Nothing here can refuse a command: a result that cannot be
//! written or read only means the command runs again under Hub's admission.
use super::runtime_private_journal::{private, write_bytes};
use super::runtime_send_journal::fingerprint;
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

const MINUTE: Duration = Duration::from_secs(60);
const DAY: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Clone, Debug)]
pub(super) struct DaemonCommandResults {
    root: PathBuf,
}

impl DaemonCommandResults {
    pub(super) fn new(root: PathBuf) -> Self {
        Self { root }
    }

    fn path(&self, control_id: &str) -> PathBuf {
        self.root
            .join(format!("{}.json", fingerprint(control_id.as_bytes())))
    }

    /// Keep a finished command's result until Hub confirms it.
    pub(super) fn keep(&self, control_id: &str, result: &Value) -> Result<(), String> {
        fs::create_dir_all(&self.root)
            .map_err(|error| format!("{}: {error}", self.root.display()))?;
        private(&self.root, true)?;
        let bytes = serde_json::to_vec(result).map_err(|error| error.to_string())?;
        let path = self.path(control_id);
        write_bytes(&path, &bytes).map_err(|error| format!("{}: {error}", path.display()))
    }

    /// The result kept for this command, if Hub has not confirmed it. A file
    /// that cannot be read as a result is removed: the command runs again.
    pub(super) fn unconfirmed(&self, control_id: &str) -> Option<Value> {
        self.read(&self.path(control_id))
    }

    /// Hub holds this command's result.
    pub(super) fn confirmed(&self, control_id: &str) {
        let _ = fs::remove_file(self.path(control_id));
    }

    /// Drop a kept `machine_quota_probe_result` once Hub rejects it
    /// non-retryably or its connection epoch ends. Other command types stay
    /// kept so a redelivered claim can rebind their result to a new lease.
    pub(super) fn drop_if_quota_probe(&self, control_id: &str) {
        if self
            .unconfirmed(control_id)
            .is_some_and(|saved| is_quota_probe_result(&saved))
        {
            self.confirmed(control_id);
        }
    }

    /// Every result Hub may still ask for. A result whose command Hub can no
    /// longer deliver is removed on the way.
    pub(super) fn all_unconfirmed(&self) -> Vec<Value> {
        let Ok(entries) = fs::read_dir(&self.root) else {
            return Vec::new();
        };
        let now = SystemTime::now();
        entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                path.extension()
                    .is_some_and(|extension| extension == "json")
            })
            .filter_map(|path| {
                let result = self.read(&path)?;
                let age = fs::metadata(&path)
                    .and_then(|metadata| metadata.modified())
                    .ok()
                    .and_then(|modified| now.duration_since(modified).ok())
                    .unwrap_or_default();
                if age > redelivery_window(&result) {
                    let _ = fs::remove_file(&path);
                    return None;
                }
                Some(result)
            })
            .collect()
    }

    fn read(&self, path: &std::path::Path) -> Option<Value> {
        let bytes = match fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
            Err(error) => {
                eprintln!(
                    "warning: unconfirmed daemon command result {} is unreadable ({error}); the command runs again if Hub delivers it",
                    path.display()
                );
                return None;
            }
        };
        match serde_json::from_slice::<Value>(&bytes) {
            Ok(result) if result.get("type").is_some_and(Value::is_string) => Some(result),
            outcome => {
                let reason = outcome.err().map_or_else(
                    || "not a daemon report".to_string(),
                    |error| error.to_string(),
                );
                eprintln!(
                    "warning: removed unconfirmed daemon command result {} ({reason}); the command runs again if Hub delivers it",
                    path.display()
                );
                let _ = fs::remove_file(path);
                None
            }
        }
    }
}

pub(super) fn is_quota_probe_result(result: &Value) -> bool {
    result.get("type").and_then(Value::as_str) == Some("machine_quota_probe_result")
}

/// How long Hub may deliver a command again: a quota probe within a minute, a
/// harness, text or worktree action within 10 minutes, anything else within
/// 30 days. The margin past that covers an action still renewing its lease.
fn redelivery_window(result: &Value) -> Duration {
    match result.get("type").and_then(Value::as_str) {
        Some("machine_quota_probe_result") => 5 * MINUTE,
        Some(
            "machine_harness_action_result"
            | "machine_text_task_result"
            | "machine_log_excerpt_result"
            | "machine_worktree_action_result",
        ) => DAY,
        _ => 31 * DAY,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn store() -> (DaemonCommandResults, PathBuf) {
        let root =
            std::env::temp_dir().join(format!("xmatrix-command-results-{}", uuid::Uuid::new_v4()));
        (DaemonCommandResults::new(root.clone()), root)
    }

    #[test]
    fn a_kept_result_answers_until_hub_confirms_it() {
        let (results, root) = store();
        // The value 4.7.0 could not read back: (1.0 - 0.9004436) * 100.0.
        let result = json!({
            "type": "machine_quota_probe_result",
            "requestId": "probe/1:a",
            "probe": { "usedPercent": (1.0 - 0.900_443_6_f64) * 100.0 },
        });
        assert_eq!(results.unconfirmed("probe/1:a"), None);
        results.keep("probe/1:a", &result).unwrap();
        results
            .keep("other", &json!({ "type": "machine_stop_result" }))
            .unwrap();
        assert_eq!(results.unconfirmed("probe/1:a"), Some(result.clone()));
        assert_eq!(results.all_unconfirmed().len(), 2);
        results.drop_if_quota_probe("probe/1:a");
        assert_eq!(results.unconfirmed("probe/1:a"), None);
        assert_eq!(results.all_unconfirmed().len(), 1);
        // Non-quota results survive `drop_if_quota_probe` so a redelivered
        // claim can still rebind them to a new lease.
        results.drop_if_quota_probe("other");
        assert!(results.unconfirmed("other").is_some());
        results.confirmed("other");
        assert!(results.all_unconfirmed().is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_damaged_result_costs_only_its_own_command() {
        let (results, root) = store();
        results
            .keep("good", &json!({ "type": "machine_stop_result" }))
            .unwrap();
        results
            .keep("bad", &json!({ "type": "machine_stop_result" }))
            .unwrap();
        fs::write(results.path("bad"), b"{\"type\":").unwrap();
        assert_eq!(results.unconfirmed("bad"), None);
        assert!(!results.path("bad").exists());
        assert!(results.unconfirmed("good").is_some());
        // The command whose result was lost keeps a new one.
        results
            .keep("bad", &json!({ "type": "machine_stop_result" }))
            .unwrap();
        assert_eq!(results.all_unconfirmed().len(), 2);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_result_hub_can_no_longer_ask_for_is_removed() {
        let (results, root) = store();
        results
            .keep("probe", &json!({ "type": "machine_quota_probe_result" }))
            .unwrap();
        results
            .keep("spawn", &json!({ "type": "machine_spawn_result" }))
            .unwrap();
        let ten_minutes_ago = SystemTime::now() - 10 * MINUTE;
        for id in ["probe", "spawn"] {
            fs::File::options()
                .write(true)
                .open(results.path(id))
                .unwrap()
                .set_modified(ten_minutes_ago)
                .unwrap();
        }
        let left = results.all_unconfirmed();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0]["type"], "machine_spawn_result");
        assert!(!results.path("probe").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn an_unwritable_store_reports_why_and_reads_as_empty() {
        let (_, root) = store();
        fs::create_dir_all(&root).unwrap();
        let blocker = root.join("file");
        fs::write(&blocker, b"x").unwrap();
        let results = DaemonCommandResults::new(blocker.join("results"));
        let error = results
            .keep("id", &json!({ "type": "machine_stop_result" }))
            .unwrap_err();
        assert!(error.contains("results"), "{error}");
        assert_eq!(results.unconfirmed("id"), None);
        assert!(results.all_unconfirmed().is_empty());
        let _ = fs::remove_dir_all(root);
    }
}
