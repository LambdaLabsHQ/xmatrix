use super::*;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

fn batch(
    root: &Path,
    origin: &str,
    after: Option<&str>,
) -> Result<Vec<(PathBuf, PendingExecution)>, String> {
    if !root.exists() {
        return Ok(Vec::new());
    }
    private(root, true)?;
    let mut paths = Vec::new();
    // An outbox over its bound is exactly the one that most needs draining, so
    // this scan takes what it can reach instead of refusing. Admission already
    // stops growth; refusing here used to stall the only path that shrinks it.
    // Admission counts every entry, so an outbox only overshoots its bound by
    // a few entries; the scan reaches twice that far so directory order cannot
    // hide a report behind lock files and strays, and stops once it holds as
    // many reports as an outbox can admit.
    for entry in fs::read_dir(root)
        .map_err(|_| "Execution outbox is unavailable")?
        .take(2 * (MAX_ENTRIES + 1))
    {
        let path = entry.map_err(|_| "Execution outbox is unavailable")?.path();
        if path.extension().is_some_and(|ext| ext == "json") {
            paths.push(path);
            if paths.len() > MAX_ENTRIES {
                break;
            }
        }
    }
    paths.sort();
    let split = after
        .map(|after| {
            paths.partition_point(|path| {
                path.file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .as_ref()
                    <= after
            })
        })
        .unwrap_or(0);
    let mut selected = Vec::new();
    for path in paths[split..].iter().chain(paths[..split].iter()) {
        let Ok(record) = read(path) else {
            continue;
        };
        if record.scope.hub_origin != origin {
            continue;
        }
        let outbox = ExecutionOutbox {
            root: root.into(),
            scope: record.scope.clone(),
        };
        if outbox.path(&record.report.execution_id)?.as_path() != path {
            continue;
        }
        selected.push((path.clone(), record));
        if selected.len() == 8 {
            break;
        }
    }
    Ok(selected)
}

fn acknowledge(path: &Path, expected: &PendingExecution) -> Result<bool, String> {
    let root = path
        .parent()
        .ok_or("Execution outbox parent is unavailable")?;
    private(root, true)?;
    // The same per-record lock its writer takes: removing a confirmed report
    // must exclude that record's owner and nothing else on the machine.
    let outbox = ExecutionOutbox {
        root: root.into(),
        scope: expected.scope.clone(),
    };
    let _guard = lock_with_deadline(&outbox.record_lock(&expected.report.execution_id)?)?;
    if !path.exists() {
        return Ok(false);
    }
    if read(path)? != *expected {
        return Ok(false);
    }
    fs::remove_file(path).map_err(|_| "Confirmed execution report could not be removed")?;
    #[cfg(unix)]
    std::fs::File::open(root)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| "Execution acknowledgement could not be persisted")?;
    Ok(true)
}

async fn drain_with<F, Fut>(
    root: PathBuf,
    origin: String,
    cursor: Arc<Mutex<Option<String>>>,
    send: F,
) -> Result<usize, String>
where
    F: Fn(Value) -> Fut,
    Fut: std::future::Future<Output = Result<Value, String>>,
{
    let after = cursor
        .lock()
        .map_err(|_| "Execution cursor is unavailable")?
        .clone();
    let records = tokio::task::spawn_blocking(move || batch(&root, &origin, after.as_deref()))
        .await
        .map_err(|_| "Execution outbox reader stopped")??;
    let started = Instant::now();
    let mut confirmed = 0;
    for (path, record) in records {
        if started.elapsed() >= Duration::from_secs(20) {
            break;
        }
        let request_id = uuid::Uuid::new_v4().to_string();
        let mut body = serde_json::to_value(&record).map_err(|_| "Execution report is invalid")?;
        body["requestId"] = json!(request_id);
        let response = tokio::time::timeout(Duration::from_secs(10), send(body)).await;
        *cursor
            .lock()
            .map_err(|_| "Execution cursor is unavailable")? = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned());
        let Ok(Ok(receipt)) = response else {
            continue;
        };
        if receipt["requestId"] != request_id
            || receipt["runId"] != record.scope.run_id
            || receipt["executionId"] != record.report.execution_id
            || receipt["revision"].as_u64() != Some(record.report.revision)
            || !matches!(
                receipt["status"].as_str(),
                Some("recorded" | "superseded" | "source_unavailable" | "expired")
            )
        {
            continue;
        }
        confirmed += usize::from(
            tokio::task::spawn_blocking(move || acknowledge(&path, &record))
                .await
                .map_err(|_| "Execution outbox acknowledgement stopped")??,
        );
    }
    Ok(confirmed)
}

async fn drain(
    hub_url: &str,
    relay: &crate::SharedMachineDaemonConnection,
    cursor: Arc<Mutex<Option<String>>>,
) {
    let Ok(hub) = reqwest::Url::parse(hub_url) else {
        return;
    };
    let endpoint = xmatrix_cli_core::protocol::with_route(hub_url, "/api/daemon/executions/report");
    let outcome = drain_with(
        config::profile_state_dir().join("execution-outbox"),
        hub.origin().ascii_serialization(),
        cursor,
        |body| {
            let endpoint = endpoint.clone();
            let token = relay.machine_credential();
            async move {
                let token =
                    token.map_err(|_| "Machine report credential is unavailable".to_string())?;
                xmatrix_cli_core::http::request_json(&endpoint, "POST", Some(&token), Some(body))
                    .await
                    .map_err(|_| "Execution acknowledgement is unavailable".to_string())
            }
        },
    )
    .await;
    if let Err(error) = outcome {
        eprintln!("Execution evidence remains queued: {error}");
    }
}

#[cfg(test)]
#[path = "runtime_execution_outbox_delivery_tests.rs"]
mod tests;

pub(crate) struct Reporter(tokio::task::JoinHandle<()>);
impl Drop for Reporter {
    fn drop(&mut self) {
        self.0.abort();
    }
}
pub(crate) fn spawn_reporter(
    hub_url: String,
    relay: crate::SharedMachineDaemonConnection,
) -> Reporter {
    Reporter(config::spawn_profile_task(async move {
        let cursor = Arc::new(Mutex::new(None));
        let mut interval = tokio::time::interval(Duration::from_secs(5));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            if relay.is_connected() {
                drain(&hub_url, &relay, cursor.clone()).await;
            }
        }
    }))
}
