//! Bounded active network quality measurements. Fixed public targets, no
//! credentials or model calls, no redirects, no privileged socket operations.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

const DOWN: &str = "https://speed.cloudflare.com/__down";
const UP: &str = "https://speed.cloudflare.com/__up";
const INTERVAL: Duration = Duration::from_secs(300);
const PACKETS: usize = 20;
static CACHE: OnceLock<Mutex<Option<Value>>> = OnceLock::new();
static STARTED: AtomicBool = AtomicBool::new(false);

/// Called only by the daemon's existing resource sampler. The task lives with
/// that daemon; probes never block admission, Run progress or resource sampling.
pub(crate) fn snapshot() -> Option<Value> {
    if cfg!(test) {
        return None;
    }
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    if let Ok(handle) = tokio::runtime::Handle::try_current()
        && !STARTED.swap(true, Ordering::AcqRel)
    {
        handle.spawn(async {
            crate::ensure_reqwest_crypto_provider();
            let Ok(client) = reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(3))
                .timeout(Duration::from_secs(8))
                .redirect(reqwest::redirect::Policy::none())
                .user_agent("xMatrix-network-quality/1")
                .build()
            else {
                STARTED.store(false, Ordering::Release);
                return;
            };
            let mut cycle = 0_u32;
            let mut transfers = (None, None);
            loop {
                let started = Instant::now();
                let measured = tokio::time::timeout(
                    Duration::from_secs(90),
                    measure(&client, cycle.is_multiple_of(12), &mut transfers),
                )
                .await
                .ok();
                *CACHE
                    .get()
                    .unwrap()
                    .lock()
                    .unwrap_or_else(|p| p.into_inner()) = measured;
                cycle = cycle.wrapping_add(1);
                let jitter =
                    Duration::from_millis((uuid::Uuid::new_v4().as_u128() % 30_000) as u64);
                tokio::time::sleep(INTERVAL.saturating_sub(started.elapsed()) + jitter).await;
            }
        });
    }
    cache.lock().ok()?.clone()
}

fn timestamp() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

fn summary(samples: &[f64]) -> Option<(f64, f64, f64)> {
    if samples.is_empty() {
        return None;
    }
    let jitter = samples
        .windows(2)
        .map(|pair| (pair[1] - pair[0]).abs())
        .sum::<f64>()
        / samples.len().saturating_sub(1).max(1) as f64;
    let mut sorted = samples.to_vec();
    sorted.sort_by(f64::total_cmp);
    let percentile = |fraction: f64| {
        sorted[((sorted.len() as f64 * fraction).ceil() as usize).saturating_sub(1)]
    };
    let middle = sorted.len() / 2;
    let median = if sorted.len().is_multiple_of(2) {
        (sorted[middle - 1] + sorted[middle]) / 2.0
    } else {
        sorted[middle]
    };
    Some((median, percentile(0.95), jitter))
}

async fn latency(client: &reqwest::Client) -> Option<f64> {
    let start = Instant::now();
    let response = client
        .get(format!(
            "{DOWN}?bytes=0&xmatrix={}",
            crate::unix_millis_now()
        ))
        .timeout(Duration::from_secs(3))
        .header("Cache-Control", "no-cache")
        .header("Accept-Encoding", "identity")
        .send()
        .await
        .ok()?;
    response
        .status()
        .is_success()
        .then(|| start.elapsed().as_secs_f64() * 1000.0)
}

async fn idle_latency(client: &reqwest::Client) -> Vec<f64> {
    // Warm the connection so the sample measures request RTT, not DNS/TLS.
    let _ = latency(client).await;
    let mut samples = Vec::new();
    for _ in 0..10 {
        if let Some(ms) = latency(client).await {
            samples.push(ms);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    samples
}

async fn transfer(client: &reqwest::Client, upload: bool, bytes: usize) -> Option<Value> {
    let start = Instant::now();
    let response = if upload {
        let mut payload = vec![0_u8; bytes];
        getrandom::fill(&mut payload).ok()?;
        client.post(UP).body(payload)
    } else {
        client.get(format!(
            "{DOWN}?bytes={bytes}&xmatrix={}",
            crate::unix_millis_now()
        ))
    }
    .header("Cache-Control", "no-cache")
    .header("Accept-Encoding", "identity")
    .send()
    .await
    .ok()?;
    if !complete_response(response, if upload { 64 * 1024 } else { bytes }, !upload).await {
        return None;
    }
    let duration = start.elapsed().as_secs_f64() * 1000.0;
    (duration >= 1.0).then(|| {
        json!({"observedAt":timestamp(), "bytes":bytes,
        "durationMs":duration, "mbps":bytes as f64 * 8.0 / duration / 1000.0,
        "shortSample":duration < 250.0})
    })
}

async fn complete_response(mut response: reqwest::Response, limit: usize, exact: bool) -> bool {
    if !response.status().is_success() {
        return false;
    }
    let mut received = 0;
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => received += chunk.len(),
            Ok(None) => break,
            Err(_) => return false,
        }
        if received > limit {
            return false;
        }
    }
    !exact || received == limit
}

async fn direction(client: &reqwest::Client, upload: bool) -> (Option<Value>, Option<f64>) {
    // Keep a second warm connection available for HTTP/1 loaded-RTT probes.
    let _ = tokio::join!(latency(client), latency(client));
    let (done, mut stopped) = tokio::sync::watch::channel(false);
    let transfer = async {
        let mut latest = None;
        // Adaptive size, at most 5.25 MiB per direction, once an hour.
        for bytes in [256 * 1024, 1024 * 1024, 4 * 1024 * 1024] {
            let Some(sample) = transfer(client, upload, bytes).await else {
                break;
            };
            let long_enough = sample["shortSample"] == false;
            latest = Some(sample);
            if long_enough {
                break;
            }
        }
        let _ = done.send(true);
        latest
    };
    let loaded_latency = async {
        let mut samples = Vec::new();
        loop {
            tokio::select! {
                _ = stopped.changed() => break,
                _ = tokio::time::sleep(Duration::from_millis(50)) => {}
            }
            tokio::select! {
                _ = stopped.changed() => break,
                ms = latency(client) => if let Some(ms) = ms { samples.push(ms); }
            }
        }
        summary(&samples).map(|(median, _, _)| median)
    };
    tokio::join!(transfer, loaded_latency)
}

async fn packet_loss() -> Option<Value> {
    let mut received = 0;
    for _ in 0..PACKETS {
        let mut command = tokio::process::Command::new("ping");
        #[cfg(windows)]
        command.args(["-n", "1", "-w", "1000", "1.1.1.1"]);
        #[cfg(target_os = "macos")]
        command.args(["-n", "-c", "1", "-W", "1000", "1.1.1.1"]);
        #[cfg(not(any(windows, target_os = "macos")))]
        command.args(["-n", "-c", "1", "-W", "1", "1.1.1.1"]);
        command.env("LC_ALL", "C").kill_on_drop(true);
        let output = tokio::time::timeout(Duration::from_millis(1500), command.output())
            .await
            .ok()?
            .ok()?;
        // Exit 2 includes unsupported flags, missing permission or local error.
        if output.status.code() == Some(2) {
            return None;
        }
        let success = output.status.success();
        // Windows ping may return success for a destination-unreachable reply.
        #[cfg(windows)]
        let success = success
            && String::from_utf8_lossy(&output.stdout)
                .to_ascii_lowercase()
                .contains("ttl=");
        received += usize::from(success);
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    // Total silence cannot distinguish filtered ICMP from actual path loss.
    (received > 0).then(|| {
        json!({"protocol":"icmp", "target":"1.1.1.1",
        "sent":PACKETS, "received":received})
    })
}

async fn measure(
    client: &reqwest::Client,
    bandwidth: bool,
    transfers: &mut (Option<Value>, Option<Value>),
) -> Value {
    // Idle measurements must finish before introducing our own transfer load.
    let (samples, loss) = tokio::join!(idle_latency(client), packet_loss());
    let mut value = json!({"observedAt":timestamp(), "target":"cloudflare-speed",
        "protocol":"https", "attempts":10, "failures":10 - samples.len()});
    if let Some((median, p95, jitter)) = summary(&samples) {
        value["latencyMedianMs"] = json!(median);
        value["latencyP95Ms"] = json!(p95);
        value["jitterMs"] = json!(jitter);
    }
    if let Some(loss) = loss {
        value["packetLoss"] = loss;
    }
    if bandwidth && !samples.is_empty() {
        let (mut down, loaded_down) = direction(client, false).await;
        let (mut up, loaded_up) = direction(client, true).await;
        if let (Some(sample), Some(ms)) = (&mut down, loaded_down) {
            sample["loadedLatencyMs"] = json!(ms);
        }
        if let (Some(sample), Some(ms)) = (&mut up, loaded_up) {
            sample["loadedLatencyMs"] = json!(ms);
        }
        *transfers = (down, up);
    }
    if let Some(down) = &transfers.0 {
        value["download"] = down.clone();
    }
    if let Some(up) = &transfers.1 {
        value["upload"] = up.clone();
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn network_summary_preserves_tail_latency_and_consecutive_jitter() {
        assert_eq!(summary(&[]), None);
        assert_eq!(
            summary(&[10.0, 30.0, 20.0, 100.0]),
            Some((25.0, 100.0, 110.0 / 3.0))
        );
    }

    #[tokio::test]
    async fn oversized_or_incomplete_http_bodies_cannot_manufacture_a_bandwidth_sample() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        crate::ensure_reqwest_crypto_provider();
        for (body, expected) in [("abcd", true), ("abc", false), ("abcde", false)] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0_u8; 4096];
                let mut count = 0;
                while !request[..count]
                    .windows(4)
                    .any(|bytes| bytes == b"\r\n\r\n")
                {
                    let read = socket.read(&mut request[count..]).await.unwrap();
                    assert!(read > 0 && count + read < request.len());
                    count += read;
                }
                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            });
            let client = reqwest::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(2))
                .build()
                .unwrap();
            let response = client
                .get(format!("http://{address}"))
                .send()
                .await
                .unwrap();
            assert_eq!(complete_response(response, 4, true).await, expected);
            server.await.unwrap();
        }
    }
}
