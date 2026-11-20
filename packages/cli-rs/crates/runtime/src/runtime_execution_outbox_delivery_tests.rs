use super::super::tests::{Fixture, report};
use super::*;
fn receipt(body: &Value) -> Value {
    json!({"requestId": body["requestId"], "runId": body["scope"]["runId"],
        "executionId":body["report"]["executionId"], "revision":body["report"]["revision"], "status":"recorded"})
}
fn cursor() -> Arc<Mutex<Option<String>>> {
    Arc::new(Mutex::new(None))
}
#[tokio::test]
async fn failure_and_mismatched_receipts_retain_the_exact_report_until_confirmed() {
    let fixture = Fixture::new();
    let outbox = fixture.outbox();
    let report = report();
    outbox.save(&report).unwrap();
    let path = outbox.path(&report.execution_id).unwrap();
    let original = fs::read(&path).unwrap();
    let position = cursor();
    assert_eq!(
        drain_with(
            outbox.root.clone(),
            outbox.scope.hub_origin.clone(),
            position.clone(),
            |_| async { Err("offline".into()) }
        )
        .await
        .unwrap(),
        0
    );
    for field in ["requestId", "runId", "executionId", "revision", "status"] {
        assert_eq!(
            drain_with(
                outbox.root.clone(),
                outbox.scope.hub_origin.clone(),
                position.clone(),
                |body| async move {
                    let mut reply = receipt(&body);
                    reply[field] = json!("wrong");
                    Ok(reply)
                }
            )
            .await
            .unwrap(),
            0
        );
        assert_eq!(fs::read(&path).unwrap(), original);
    }
    assert_eq!(
        drain_with(
            outbox.root.clone(),
            outbox.scope.hub_origin.clone(),
            position,
            |body| async move {
                assert!(body["scope"].get("executionKey").is_none());
                Ok(receipt(&body))
            }
        )
        .await
        .unwrap(),
        1
    );
    assert!(!path.exists());
}
#[tokio::test]
async fn an_older_ack_cannot_delete_a_newer_persisted_result() {
    let fixture = Fixture::new();
    let outbox = fixture.outbox();
    let first = report();
    outbox.save(&first).unwrap();
    let mut newer = first.clone();
    newer.revision += 1;
    newer.state = "completed".into();
    newer.finished_at_millis = Some(200);
    newer.updated_at_millis = 200;
    assert_eq!(
        drain_with(
            outbox.root.clone(),
            outbox.scope.hub_origin.clone(),
            cursor(),
            |body| {
                outbox.save(&newer).unwrap();
                std::future::ready(Ok(receipt(&body)))
            }
        )
        .await
        .unwrap(),
        0
    );
    assert_eq!(
        read(&outbox.path(&first.execution_id).unwrap())
            .unwrap()
            .report,
        newer
    );
}
#[tokio::test]
async fn bounded_batches_rotate_past_failures_and_do_not_cross_hubs() {
    let fixture = Fixture::new();
    let outbox = fixture.outbox();
    for _ in 0..20 {
        outbox.save(&report()).unwrap();
    }
    let mut foreign = outbox.clone();
    foreign.scope.hub_origin = "https://other.test".into();
    let foreign_report = report();
    foreign.save(&foreign_report).unwrap();
    let position = cursor();
    let denied = Arc::new(Mutex::new(std::collections::HashSet::new()));
    let initial = batch(&outbox.root, &outbox.scope.hub_origin, None).unwrap();
    assert_eq!(initial.len(), 8);
    for (_, record) in initial {
        denied.lock().unwrap().insert(record.report.execution_id);
    }
    let mut count = 0;
    for _ in 0..4 {
        count += drain_with(
            outbox.root.clone(),
            outbox.scope.hub_origin.clone(),
            position.clone(),
            |body| {
                assert_eq!(body["scope"]["hubOrigin"], "https://hub.test");
                std::future::ready(
                    if denied
                        .lock()
                        .unwrap()
                        .contains(body["report"]["executionId"].as_str().unwrap())
                    {
                        Err("refused".into())
                    } else {
                        Ok(receipt(&body))
                    },
                )
            },
        )
        .await
        .unwrap();
    }
    assert_eq!(count, 12);
    assert!(foreign.path(&foreign_report.execution_id).unwrap().exists());
    // Records are the `.json` files. Each now sits beside a lock file of its
    // own, which is bookkeeping and must never be counted as a pending report
    // nor keep an acknowledged one alive.
    let records = |root: &Path| {
        fs::read_dir(root)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
            .count()
    };
    assert_eq!(records(&outbox.root), 9); // 8 refused and still pending + the foreign Hub's record.
    assert!(
        batch(&outbox.root, &outbox.scope.hub_origin, None)
            .unwrap()
            .iter()
            .all(|(path, _)| path.extension().is_some_and(|ext| ext == "json")),
        "a lock file must never be drained as if it were a report",
    );
}

/// Admission stops growth; the drain is what shrinks an outbox. An outbox past
/// its bound must therefore still be drainable, or it can never recover.
#[test]
fn an_over_full_outbox_is_still_drainable() {
    let fixture = Fixture::new();
    let outbox = fixture.outbox();
    let first = report();
    outbox.save(&first).unwrap();
    fs::create_dir_all(&outbox.root).unwrap();
    for n in 0..(MAX_ENTRIES + 4) {
        fs::write(outbox.root.join(format!("filler-{n}.txt")), b"x").unwrap();
    }
    let selected = batch(&outbox.root, &outbox.scope.hub_origin, None).unwrap();
    assert!(
        selected
            .iter()
            .any(|(_, record)| record.report.execution_id == first.execution_id),
        "an over-full outbox must still surface its pending reports",
    );
}

fn entries(root: &Path) -> Vec<String> {
    let mut names = fs::read_dir(root)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    names.sort();
    names
}

/// A confirmed report leaves nothing behind. Its lock file used to stay, and
/// admission counts every entry, so 1024 delivered reports filled the outbox
/// for good.
#[tokio::test]
async fn a_delivered_report_leaves_no_lock_behind() {
    let fixture = Fixture::new();
    let outbox = fixture.outbox();
    let report = report();
    outbox.save(&report).unwrap();
    let lock = outbox.record_lock(&report.execution_id).unwrap();
    batch(&outbox.root, &outbox.scope.hub_origin, None).unwrap();
    assert!(lock.exists(), "a pending report keeps its lock");
    assert_eq!(
        drain_with(
            outbox.root.clone(),
            outbox.scope.hub_origin.clone(),
            cursor(),
            |body| async move { Ok(receipt(&body)) }
        )
        .await
        .unwrap(),
        1
    );
    batch(&outbox.root, &outbox.scope.hub_origin, None).unwrap();
    assert_eq!(entries(&outbox.root), Vec::<String>::new());
}

/// The state machines in the field are in: every slot taken by the lock of a
/// report delivered long ago. One pass frees them and the outbox admits again.
#[test]
fn an_outbox_filled_by_leftover_locks_admits_again() {
    let fixture = Fixture::new();
    let outbox = fixture.outbox();
    fs::create_dir_all(&outbox.root).unwrap();
    for n in 0..MAX_ENTRIES - 1 {
        fs::write(outbox.root.join(format!("{n:064}.lock")), b"").unwrap();
    }
    let pending = report();
    assert!(outbox.save(&pending).unwrap_err().contains("full"));
    let held = outbox.root.join(format!("{:064}.lock", 0));
    let holder = crate::runtime_private_journal::lock(&held).unwrap();
    batch(&outbox.root, &outbox.scope.hub_origin, None).unwrap();
    assert_eq!(entries(&outbox.root), vec![format!("{:064}.lock", 0)]);
    drop(holder);
    outbox.save(&pending).unwrap();
    batch(&outbox.root, &outbox.scope.hub_origin, None).unwrap();
    assert!(outbox.path(&pending.execution_id).unwrap().exists());
    assert!(outbox.record_lock(&pending.execution_id).unwrap().exists());
}
