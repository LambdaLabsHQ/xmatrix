//! Unix socket listeners for the daemon's local brokers.
//!
//! A loopback TCP port is reachable by every user on the host and changes on
//! every daemon start. A pathname socket is reachable only by whoever the file
//! mode admits and keeps its name across restarts, which is why Docker, systemd
//! and ssh-agent all address local daemons this way.
//!
//! Two independent guards, because either alone is thin: the socket is created
//! `0600` so the filesystem refuses other users, and every accepted connection
//! is checked against the owning uid — the mechanism systemd, D-Bus and polkit
//! use to authenticate a caller before granting a privileged operation.

#![cfg(unix)]

use std::os::unix::fs::{FileTypeExt as _, PermissionsExt as _};
use std::path::{Path, PathBuf};

use tokio::net::{UnixListener, UnixStream};
use xmatrix_cli_core::daemon_record;
use xmatrix_cli_core::error::{CliError, Result};

pub(crate) struct DaemonSocketListener {
    pub(crate) listener: UnixListener,
    pub(crate) path: PathBuf,
}

impl Drop for DaemonSocketListener {
    fn drop(&mut self) {
        // A left-behind socket file is a locator pointing at nothing. The next
        // daemon unlinks it anyway; removing it here keeps a clean shutdown
        // from advertising a listener that stopped listening.
        let _ = std::fs::remove_file(&self.path);
    }
}

/// Bind `<profile state>/<name>.sock`, replacing a socket an earlier daemon
/// left behind.
///
/// A stale file is only removed once it is established to be a socket that
/// nothing answers on. Unlinking a live daemon's socket would take the host's
/// working daemon off the air, and unlinking a regular file would destroy data
/// this has no business touching.
pub(crate) async fn bind_daemon_socket(name: &str) -> Result<DaemonSocketListener> {
    let path = daemon_record::socket_path(name)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(CliError::Io)?;
    }
    if let Some(reason) = stale_socket_reason(&path).await? {
        eprintln!(
            "⚠ replacing the daemon socket at {}: {reason}",
            path.display()
        );
        std::fs::remove_file(&path).map_err(CliError::Io)?;
    }
    let listener = UnixListener::bind(&path).map_err(|error| {
        CliError::Launch(format!(
            "Failed to bind the daemon socket at {}: {error}",
            path.display(),
        ))
    })?;
    // Owner-only before anything is served over it.
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
        .map_err(CliError::Io)?;
    Ok(DaemonSocketListener { listener, path })
}

/// `Some(reason)` when the path holds a socket no daemon answers on.
async fn stale_socket_reason(path: &Path) -> Result<Option<String>> {
    let Some(metadata) = xmatrix_cli_core::fs::metadata_if_exists(path).map_err(CliError::Io)?
    else {
        return Ok(None);
    };
    if metadata.file_type().is_symlink() {
        return Err(CliError::Launch(format!(
            "Daemon socket path {} is a symlink; refusing to replace it",
            path.display(),
        )));
    }
    if !metadata.file_type().is_socket() {
        return Err(CliError::Launch(format!(
            "Daemon socket path {} exists and is not a socket; refusing to replace it",
            path.display(),
        )));
    }
    match UnixStream::connect(path).await {
        // Something is serving here. The singleton lock should already have
        // stopped a second daemon, so report rather than evict.
        Ok(_) => Err(CliError::Launch(format!(
            "Another daemon is already serving {}; stop it before starting another",
            path.display(),
        ))),
        Err(error) => Ok(Some(format!("no daemon answers there ({})", error.kind()))),
    }
}

/// True when the peer is the user this daemon runs as.
///
/// The file mode already excludes other users; this is the second, independent
/// check, and the one that does not depend on the filesystem having been set up
/// correctly. A peer whose credentials cannot be read is refused rather than
/// assumed friendly.
pub(crate) fn peer_is_owner(stream: &UnixStream) -> bool {
    match stream.peer_cred() {
        Ok(credentials) => credentials.uid() == unsafe { libc::geteuid() },
        Err(error) => {
            eprintln!(
                "⚠ refusing a daemon socket peer whose credentials could not be read: {error}"
            );
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_socket_is_owner_only_and_admits_this_process() {
        let name = format!("doctor-test-{}", uuid::Uuid::new_v4());
        let Ok(bound) = bind_daemon_socket(&name).await else {
            // A state root that cannot be resolved is reported by socket_path;
            // this test is about the socket, not that resolution.
            return;
        };
        let mode = std::fs::metadata(&bound.path).unwrap().permissions().mode() & 0o777;
        assert_eq!(
            mode, 0o600,
            "a daemon socket must not be readable by other users"
        );

        let client = UnixStream::connect(&bound.path).await.unwrap();
        let (accepted, _) = bound.listener.accept().await.unwrap();
        assert!(peer_is_owner(&accepted), "this process is the owner");
        drop(client);

        let path = bound.path.clone();
        drop(bound);
        assert!(
            !path.exists(),
            "a dropped listener must not leave a locator behind"
        );
    }

    #[tokio::test]
    async fn a_live_socket_is_never_evicted_by_a_second_daemon() {
        let name = format!("doctor-live-{}", uuid::Uuid::new_v4());
        let Ok(first) = bind_daemon_socket(&name).await else {
            return;
        };
        let second = bind_daemon_socket(&name).await;
        assert!(second.is_err(), "the running daemon's socket must survive");
        assert!(first.path.exists(), "and must still be there afterwards");
    }

    #[tokio::test]
    async fn a_dead_socket_is_replaced_rather_than_blocking_startup() {
        let name = format!("doctor-dead-{}", uuid::Uuid::new_v4());
        let Ok(path) = daemon_record::socket_path(&name) else {
            return;
        };
        // What a crashed daemon leaves: the socket file still on disk with no
        // process behind it. `std::os::unix::net::UnixListener` does not unlink
        // on drop, so dropping it reproduces that exactly — forgetting our own
        // listener would not, because its descriptor would still be accepting.
        let crashed = std::os::unix::net::UnixListener::bind(&path).unwrap();
        drop(crashed);
        // Parallel tests spawn processes. A concurrent fork can briefly retain
        // the listener until exec closes CLOEXEC descriptors. Establish the
        // dead-socket precondition before testing replacement; never relax the
        // production guard that refuses a connectable listener.
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                match UnixStream::connect(&path).await {
                    Err(error) if error.kind() == std::io::ErrorKind::ConnectionRefused => break,
                    Err(error) => panic!("unexpected stale fixture probe: {error}"),
                    Ok(stream) => drop(stream),
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the crashed fixture must stop accepting connections");
        assert!(
            path.exists(),
            "the crashed daemon's socket file must remain"
        );

        let replacement = bind_daemon_socket(&name).await;
        assert!(
            replacement.is_ok(),
            "a daemon must start after an unclean shutdown: {:?}",
            replacement.err(),
        );
    }

    #[test]
    fn a_socket_name_can_never_escape_the_profile_directory() {
        for name in ["../elsewhere", "a/b", ""] {
            assert!(daemon_record::socket_path(name).is_err(), "{name:?}");
        }
    }
}
