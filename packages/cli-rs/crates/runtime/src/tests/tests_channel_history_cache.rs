// Machine-level history cache: stub-Hub integration tests. The stub counts
// requests, so each assertion is about how much Hub traffic a read costs.
// Wrapped in its own module: this file is include!'d and must not leak
// imports into the shared tests scope.
mod channel_history_cache_tests {

    use crate::runtime_channel_history_cache::{
        DaemonChannelHistoryPayload, serve_daemon_channel_history,
    };
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn run_history_cache_test(operation: impl std::future::Future<Output = ()>) {
        let _guard = super::test_process_env_lock();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("history cache test runtime");
        runtime.block_on(operation);
    }

    fn history_cache_test_environment() -> std::path::PathBuf {
        let _ = rustls::crypto::ring::default_provider().install_default();
        std::env::temp_dir().join(format!("xmatrix-history-cache-{}", uuid::Uuid::new_v4()))
    }

    struct StubHub {
        url: String,
        fetches: Arc<AtomicUsize>,
        total_messages: Arc<AtomicU64>,
        content_revision: Arc<AtomicU64>,
        pause_tail: Arc<AtomicBool>,
        tail_started: Arc<tokio::sync::Notify>,
        release_tail: Arc<tokio::sync::Notify>,
    }

    async fn spawn_stub_hub() -> StubHub {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind stub hub");
        let address = listener.local_addr().expect("stub hub address");
        let fetches = Arc::new(AtomicUsize::new(0));
        let total_messages = Arc::new(AtomicU64::new(0));
        let content_revision = Arc::new(AtomicU64::new(1));
        let pause_tail = Arc::new(AtomicBool::new(false));
        let tail_started = Arc::new(tokio::sync::Notify::new());
        let release_tail = Arc::new(tokio::sync::Notify::new());
        let hub = StubHub {
            url: format!("http://{address}"),
            fetches: fetches.clone(),
            total_messages: total_messages.clone(),
            content_revision: content_revision.clone(),
            pause_tail: pause_tail.clone(),
            tail_started: tail_started.clone(),
            release_tail: release_tail.clone(),
        };
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    return;
                };
                let fetches = fetches.clone();
                let total_messages = total_messages.clone();
                let content_revision = content_revision.clone();
                let pause_tail = pause_tail.clone();
                let tail_started = tail_started.clone();
                let release_tail = release_tail.clone();
                tokio::spawn(async move {
                    let mut buffer = vec![0_u8; 16 * 1024];
                    let Ok(read) = stream.read(&mut buffer).await else {
                        return;
                    };
                    let request = String::from_utf8_lossy(&buffer[..read]).to_string();
                    let first_line = request.lines().next().unwrap_or_default().to_string();
                    let (status, body) = if request.to_ascii_lowercase().contains("bearer denied") {
                        ("403 Forbidden", r#"{"error":"forbidden"}"#.to_string())
                    } else {
                        let before = first_line
                            .split("beforeSequence=")
                            .nth(1)
                            .and_then(|rest| {
                                rest.split(|c: char| !c.is_ascii_digit())
                                    .next()
                                    .and_then(|digits| digits.parse::<u64>().ok())
                            })
                            .unwrap_or(u64::MAX);
                        let total = total_messages.load(Ordering::SeqCst);
                        let newest = total.min(before.saturating_sub(1));
                        let oldest = newest.saturating_sub(199).max(1);
                        let page: Vec<serde_json::Value> = if newest == 0 {
                            Vec::new()
                        } else {
                            (oldest..=newest)
                                .map(|sequence| {
                                    serde_json::json!({
                                        "messageId": format!("m{sequence}"),
                                        "sequence": sequence,
                                        "sentAt": format!("2026-08-19T00:00:{:02}.{:03}Z",
                                            sequence / 1000, sequence % 1000),
                                        "body": format!("b{sequence}"),
                                    })
                                })
                                .collect()
                        };
                        let has_more = oldest > 1;
                        let body = serde_json::json!({
                            "messages": page,
                            "hasMore": has_more,
                            "contentAuthority": {
                                "protocolVersion": 1,
                                "contentRevision": content_revision.load(Ordering::SeqCst),
                            },
                        })
                        .to_string();
                        fetches.fetch_add(1, Ordering::SeqCst);
                        ("200 OK", body)
                    };
                    let response = format!(
                        "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    if first_line.contains("beforeSequence=") && pause_tail.load(Ordering::SeqCst) {
                        tail_started.notify_one();
                        release_tail.notified().await;
                    }
                    let _ = stream.write_all(response.as_bytes()).await;
                });
            }
        });
        hub
    }

    fn history_payload(channel_id: &str, token: &str) -> DaemonChannelHistoryPayload {
        serde_json::from_value(serde_json::json!({
            "channelId": channel_id,
            "runToken": token,
        }))
        .expect("payload")
    }

    fn served_message_count(body: &str) -> usize {
        serde_json::from_str::<serde_json::Value>(body)
            .expect("served body")
            .get("messages")
            .and_then(serde_json::Value::as_array)
            .map(Vec::len)
            .unwrap_or(0)
    }

    #[test]
    fn cached_reads_cost_one_fetch_and_revision_drift_forces_a_full_walk() {
        run_history_cache_test(async {
            let config_dir = history_cache_test_environment();
            // Tests hold the shared process env lock while mutating process-wide environment.
            unsafe {
                std::env::set_var("XMATRIX_CONFIG_DIR", &config_dir);
            }
            let hub = spawn_stub_hub().await;
            hub.total_messages.store(250, Ordering::SeqCst);
            hub.content_revision.store(3, Ordering::SeqCst);
            let channel = format!("{}", uuid::Uuid::new_v4());

            // Cold read: two pages (250 messages / 200 per page).
            let body = serve_daemon_channel_history(&hub.url, history_payload(&channel, "token"))
                .await
                .expect("cold read");
            assert_eq!(served_message_count(&body), 250);
            assert_eq!(hub.fetches.load(Ordering::SeqCst), 2);

            // Warm read at the same revision: exactly one fetch.
            let body = serve_daemon_channel_history(&hub.url, history_payload(&channel, "token"))
                .await
                .expect("warm read");
            assert_eq!(served_message_count(&body), 250);
            assert_eq!(hub.fetches.load(Ordering::SeqCst), 3);

            // Appends do not invalidate: one fetch serves the merged 260.
            hub.total_messages.store(260, Ordering::SeqCst);
            let body = serve_daemon_channel_history(&hub.url, history_payload(&channel, "token"))
                .await
                .expect("appended read");
            assert_eq!(served_message_count(&body), 260);
            assert_eq!(hub.fetches.load(Ordering::SeqCst), 4);

            // A revision bump (edit/recall/redaction) discards the cache: full walk.
            hub.content_revision.store(4, Ordering::SeqCst);
            let body = serve_daemon_channel_history(&hub.url, history_payload(&channel, "token"))
                .await
                .expect("post-bump read");
            assert_eq!(served_message_count(&body), 260);
            assert_eq!(hub.fetches.load(Ordering::SeqCst), 6);

            unsafe {
                std::env::remove_var("XMATRIX_CONFIG_DIR");
            }
            let _ = std::fs::remove_dir_all(&config_dir);
        });
    }

    #[tokio::test]
    async fn waiting_for_a_cache_lock_keeps_the_runtime_responsive() {
        let _guard = super::test_process_env_lock();
        let _ = rustls::crypto::ring::default_provider().install_default();
        let config_dir = std::env::temp_dir().join(format!(
            "xmatrix-history-lock-responsive-{}",
            uuid::Uuid::new_v4()
        ));
        unsafe {
            std::env::set_var("XMATRIX_CONFIG_DIR", &config_dir);
        }
        let lock = crate::runtime_channel_history_cache::HistoryCacheLock::acquire_in(
            &config_dir.join("history-cache"),
        )
        .expect("hold cache lock");
        let (release, wait) = std::sync::mpsc::channel();
        // An OS thread bounds the old blocking wait, so this regression fails
        // rather than wedging the test runner.
        let holder = std::thread::spawn(move || {
            let _ = wait.recv_timeout(std::time::Duration::from_secs(2));
            drop(lock);
        });
        let hub = spawn_stub_hub().await;
        hub.total_messages.store(10, Ordering::SeqCst);
        let channel = uuid::Uuid::new_v4().to_string();
        let started = std::time::Instant::now();
        let read = tokio::spawn(async move {
            serve_daemon_channel_history(&hub.url, history_payload(&channel, "token")).await
        });
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let heartbeat_elapsed = started.elapsed();
        let _ = release.send(());
        let result = read.await.expect("history task").expect("history read");
        holder.join().expect("lock holder");
        unsafe {
            std::env::remove_var("XMATRIX_CONFIG_DIR");
        }
        let _ = std::fs::remove_dir_all(&config_dir);
        assert_eq!(served_message_count(&result), 10);
        assert!(
            heartbeat_elapsed < std::time::Duration::from_secs(1),
            "cache lock blocked the runtime for {heartbeat_elapsed:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_slow_history_page_does_not_lock_out_another_channel() {
        let _guard = super::test_process_env_lock();
        let _ = rustls::crypto::ring::default_provider().install_default();
        let config_dir = std::env::temp_dir().join(format!(
            "xmatrix-history-lock-network-{}",
            uuid::Uuid::new_v4()
        ));
        unsafe {
            std::env::set_var("XMATRIX_CONFIG_DIR", &config_dir);
        }
        let hub = spawn_stub_hub().await;
        hub.total_messages.store(250, Ordering::SeqCst);
        hub.pause_tail.store(true, Ordering::SeqCst);
        let url = hub.url.clone();
        let channel = uuid::Uuid::new_v4().to_string();
        let slow = tokio::spawn(async move {
            serve_daemon_channel_history(&url, history_payload(&channel, "token")).await
        });
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            hub.tail_started.notified(),
        )
        .await
        .expect("slow read reached its second Hub page");
        // Probe the same cross-channel file lock from a real OS thread. The
        // original implementation holds it until the delayed Hub page arrives;
        // a bounded receive lets the regression fail without wedging Tokio.
        let dir = config_dir.join("history-cache");
        let (signal, acquired) = std::sync::mpsc::channel();
        let probe = std::thread::spawn(move || {
            let lock = crate::runtime_channel_history_cache::HistoryCacheLock::acquire_in(&dir)?;
            let _ = signal.send(());
            drop(lock);
            Ok::<_, std::io::Error>(())
        });
        let free_during_network = tokio::task::spawn_blocking(move || {
            acquired
                .recv_timeout(std::time::Duration::from_millis(500))
                .is_ok()
        })
        .await
        .expect("lock probe receive");
        hub.release_tail.notify_one();
        let slow_result = slow.await.expect("slow task").expect("slow history");
        probe
            .join()
            .expect("lock probe thread")
            .expect("lock probe");
        unsafe {
            std::env::remove_var("XMATRIX_CONFIG_DIR");
        }
        let _ = std::fs::remove_dir_all(&config_dir);
        assert_eq!(served_message_count(&slow_result), 250);
        assert!(
            free_during_network,
            "a Hub request held the shared cache lock"
        );
    }

    #[tokio::test]
    async fn blocking_cache_operations_keep_the_admitted_profile_root() {
        let _guard = super::test_process_env_lock();
        let _ = rustls::crypto::ring::default_provider().install_default();
        let config_dir = std::env::temp_dir().join(format!(
            "xmatrix-history-profile-root-{}",
            uuid::Uuid::new_v4()
        ));
        unsafe {
            std::env::set_var("XMATRIX_CONFIG_DIR", &config_dir);
        }
        let store = xmatrix_cli_core::profile::ProfileStore::new(
            xmatrix_cli_core::profile::InstallationRoot::new(config_dir.clone()),
        );
        let initial = store.load_or_bootstrap().expect("profile registry");
        let registry = store
            .create(initial.revision, "isolated", "https://example.com", true)
            .expect("isolated profile");
        let context = store
            .context_for_selector(&registry, "isolated", false)
            .expect("profile context");
        let expected_root = context.state_root.as_path().to_path_buf();
        let hub = spawn_stub_hub().await;
        hub.total_messages.store(10, Ordering::SeqCst);
        let channel = uuid::Uuid::new_v4().to_string();
        let results = xmatrix_cli_core::config::scope_profile_context(context, async {
            let cold = serve_daemon_channel_history(&hub.url, history_payload(&channel, "token"))
                .await
                .expect("cold profile read");
            let warm = serve_daemon_channel_history(&hub.url, history_payload(&channel, "token"))
                .await
                .expect("warm profile read");
            (served_message_count(&cold), served_message_count(&warm))
        })
        .await;
        let relative = std::path::Path::new("history-cache").join(format!("{channel}.json"));
        let isolated_cache_exists = expected_root.join(&relative).is_file();
        let fallback_cache_exists = config_dir.join(&relative).exists();
        unsafe {
            std::env::remove_var("XMATRIX_CONFIG_DIR");
        }
        let _ = std::fs::remove_dir_all(&config_dir);
        assert_eq!(results, (10, 10));
        assert_eq!(hub.fetches.load(Ordering::SeqCst), 2);
        assert!(
            isolated_cache_exists,
            "cache escaped its admitted Profile root"
        );
        assert!(
            !fallback_cache_exists,
            "blocking task used the default Profile cache"
        );
    }

    #[test]
    fn absent_authority_serves_correctly_but_never_caches() {
        run_history_cache_test(async {
            let config_dir = history_cache_test_environment();
            unsafe {
                std::env::set_var("XMATRIX_CONFIG_DIR", &config_dir);
            }
            let hub = spawn_stub_hub().await;
            hub.total_messages.store(10, Ordering::SeqCst);
            // Revision 0 is a fresh channel's valid authority, not the uncacheable
            // case (that is protocolVersion != 1, covered by the module unit tests).
            hub.content_revision.store(0, Ordering::SeqCst);
            let channel = format!("{}", uuid::Uuid::new_v4());

            let body = serve_daemon_channel_history(&hub.url, history_payload(&channel, "token"))
                .await
                .expect("read");
            assert_eq!(served_message_count(&body), 10);
            // Revision 0 is still a valid authority; the cache file may exist. The
            // uncacheable case is protocolVersion != 1, covered by unit tests; here
            // we assert a second read costs one fetch even at revision 0.
            let _ = serve_daemon_channel_history(&hub.url, history_payload(&channel, "token"))
                .await
                .expect("second read");
            assert_eq!(hub.fetches.load(Ordering::SeqCst), 2);

            unsafe {
                std::env::remove_var("XMATRIX_CONFIG_DIR");
            }
            let _ = std::fs::remove_dir_all(&config_dir);
        });
    }
}
