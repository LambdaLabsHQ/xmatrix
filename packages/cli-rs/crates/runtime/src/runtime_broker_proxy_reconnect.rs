use std::io::{self, Read};
use std::net::{SocketAddr, TcpStream};
use std::path::Path;
use std::time::Duration;

use serde::Deserialize;

const MAX_BROKER_STATE_BYTES: u64 = 4096;

pub(super) fn loopback_broker_address(url: &str) -> io::Result<SocketAddr> {
    let address = url
        .strip_prefix("http://")
        .and_then(|value| value.parse::<SocketAddr>().ok())
        .filter(|address| address.ip().is_loopback() && address.port() != 0)
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "broker URL is not loopback HTTP",
            )
        })?;
    Ok(address)
}

fn discovered_broker_url(path: &Path) -> io::Result<Option<String>> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > MAX_BROKER_STATE_BYTES
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "unsafe broker state file",
        ));
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)?
        .take(MAX_BROKER_STATE_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_BROKER_STATE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "oversized broker state file",
        ));
    }
    #[derive(Deserialize)]
    struct State {
        url: String,
    }
    let state: State = serde_json::from_slice(&bytes)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid broker state file"))?;
    loopback_broker_address(&state.url)?;
    Ok(Some(state.url))
}

/// Resolve legacy daemon routing before sending request bytes. An old port may
/// already have been reused, so a current Profile locator wins even if it accepts
/// connections. The caller retains its original scoped upstream capability.
pub(super) fn connect_broker_upstream(
    target_url: &str,
    state_path: &Path,
    timeout: Duration,
) -> io::Result<(TcpStream, String)> {
    loopback_broker_address(target_url)?;
    let selected = discovered_broker_url(state_path)?.unwrap_or_else(|| target_url.to_string());
    let stream = TcpStream::connect_timeout(&loopback_broker_address(&selected)?, timeout)?;
    Ok((stream, selected))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpListener;

    struct Fixture(std::path::PathBuf);

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir()
                .join(format!("xmatrix-broker-reconnect-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&root).unwrap();
            Self(root)
        }

        fn state(&self, name: &str, url: &str) -> std::path::PathBuf {
            let path = self.0.join(name);
            std::fs::write(&path, serde_json::json!({ "url": url }).to_string()).unwrap();
            path
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn listener() -> (TcpListener, String) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        (listener, url)
    }

    #[test]
    fn replaced_daemon_port_receives_the_original_run_proof() {
        let root = Fixture::new();
        let (old, old_url) = listener();
        let (new, new_url) = listener();
        drop(old);
        let state = root.state("daemon-auth-broker.json", &new_url);
        let (mut upstream, selected) =
            connect_broker_upstream(&old_url, &state, Duration::from_secs(1)).unwrap();
        assert_eq!(selected, new_url);
        let (mut receiver, _) = new.accept().unwrap();
        let request =
            b"GET /auth/token HTTP/1.1\r\nx-xmatrix-auth-capability: original-run-proof\r\n\r\n";
        upstream.write_all(request).unwrap();
        let mut bytes = vec![0; request.len()];
        receiver.read_exact(&mut bytes).unwrap();
        assert_eq!(bytes, request);
    }

    #[test]
    fn reused_old_port_never_receives_the_run_proof_or_a_replayed_write() {
        let root = Fixture::new();
        let (current, current_url) = listener();
        let (other, other_url) = listener();
        current.set_nonblocking(true).unwrap();
        let state = root.state("daemon-request-broker.json", &other_url);
        let (mut stream, selected) =
            connect_broker_upstream(&current_url, &state, Duration::from_secs(1)).unwrap();
        assert_eq!(selected, other_url);
        let (mut receiver, _) = other.accept().unwrap();
        stream.write_all(b"POST").unwrap();
        let mut bytes = [0; 4];
        receiver.read_exact(&mut bytes).unwrap();
        drop(receiver);
        assert_eq!(
            current.accept().unwrap_err().kind(),
            io::ErrorKind::WouldBlock
        );
    }

    #[test]
    fn discovery_is_bounded_and_cannot_redirect_credentials_off_host() {
        let root = Fixture::new();
        let (old, old_url) = listener();
        drop(old);
        for url in [
            "https://127.0.0.1:1234",
            "http://192.0.2.1:1234",
            "http://localhost:1234",
            "http://127.0.0.1:0",
            "http://127.0.0.1:1234/auth/token",
        ] {
            let state = root.state("daemon-auth-broker.json", url);
            assert_eq!(
                connect_broker_upstream(&old_url, &state, Duration::from_secs(1))
                    .unwrap_err()
                    .kind(),
                io::ErrorKind::InvalidData
            );
        }
        let state = root.0.join("daemon-auth-broker.json");
        std::fs::write(&state, vec![b' '; MAX_BROKER_STATE_BYTES as usize + 1]).unwrap();
        assert_eq!(
            connect_broker_upstream(&old_url, &state, Duration::from_secs(1))
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidData
        );
        std::fs::write(&state, b"not-json").unwrap();
        assert_eq!(
            connect_broker_upstream(&old_url, &state, Duration::from_secs(1))
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidData
        );
    }

    #[test]
    fn discovery_stays_in_the_captured_profile_and_broker_kind() {
        let root = Fixture::new();
        let (old, old_url) = listener();
        let (_other, other_url) = listener();
        root.state("daemon-request-broker.json", &other_url);
        let missing = root.0.join("daemon-auth-broker.json");
        let (_, selected) =
            connect_broker_upstream(&old_url, &missing, Duration::from_secs(1)).unwrap();
        assert_eq!(selected, old_url);
        let unchanged = root.state("daemon-auth-broker.json", &old_url);
        let (_, selected) =
            connect_broker_upstream(&old_url, &unchanged, Duration::from_secs(1)).unwrap();
        assert_eq!(selected, old_url);
        drop(old);
    }

    #[cfg(unix)]
    #[test]
    fn discovery_rejects_symlinked_state() {
        let root = Fixture::new();
        let (old, old_url) = listener();
        let (_new, new_url) = listener();
        drop(old);
        let target = root.state("target.json", &new_url);
        let link = root.0.join("daemon-auth-broker.json");
        std::os::unix::fs::symlink(target, &link).unwrap();
        assert_eq!(
            connect_broker_upstream(&old_url, &link, Duration::from_secs(1))
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidData
        );
    }
}
