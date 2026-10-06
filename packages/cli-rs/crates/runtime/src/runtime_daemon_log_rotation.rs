use std::fs::{self, File, OpenOptions};
use std::io::{self, ErrorKind, Seek, SeekFrom};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

#[cfg(target_os = "macos")]
const DAEMON_LOG_MAX_BYTES: u64 = 16 * 1024 * 1024;
#[cfg(target_os = "macos")]
const DAEMON_LOG_RETAIN_BYTES: u64 = 4 * 1024 * 1024;
#[cfg(target_os = "macos")]
const DAEMON_LOG_ROTATION_INTERVAL_SECS: u64 = 15 * 60;

#[cfg(target_os = "macos")]
pub(crate) fn spawn_macos_daemon_log_rotation_task() -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(
            DAEMON_LOG_ROTATION_INTERVAL_SECS,
        ));
        loop {
            interval.tick().await;
            match tokio::task::spawn_blocking(rotate_macos_daemon_logs).await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => eprintln!("warning: daemon log rotation failed: {error}"),
                Err(error) => eprintln!("warning: daemon log rotation task failed: {error}"),
            }
        }
    })
}

#[cfg(target_os = "macos")]
fn rotate_macos_daemon_logs() -> io::Result<()> {
    let home = dirs::home_dir()
        .ok_or_else(|| io::Error::new(ErrorKind::NotFound, "home directory is unavailable"))?;
    let log_directory = home.join("Library").join("Logs");
    for (fd, filename) in [
        (libc::STDOUT_FILENO, "xmatrix-daemon.log"),
        (libc::STDERR_FILENO, "xmatrix-daemon.err.log"),
    ] {
        let path = log_directory.join(filename);
        rotate_bound_log(&path, fd, DAEMON_LOG_MAX_BYTES, DAEMON_LOG_RETAIN_BYTES)?;
    }
    Ok(())
}

/// Keeps launchd's open file descriptor valid by truncating in place, then
/// rebinding this daemon's matching descriptor to the new append position. A
/// rename-based rotation would leave launchd writing to an unlinked file.
fn rotate_bound_log(
    log_path: &Path,
    target_fd: libc::c_int,
    maximum_bytes: u64,
    retained_bytes: u64,
) -> io::Result<bool> {
    let metadata = match fs::symlink_metadata(log_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() <= maximum_bytes
        || !fd_matches_path(target_fd, &metadata)
    {
        return Ok(false);
    }

    let parent = log_path.parent().ok_or_else(|| {
        io::Error::new(
            ErrorKind::InvalidInput,
            "daemon log path has no parent directory",
        )
    })?;
    let (temporary_path, mut temporary) = create_rotation_temporary(parent)?;
    let result = (|| {
        let mut source = File::open(log_path)?;
        source.seek(SeekFrom::End(
            -i64::try_from(metadata.len().min(retained_bytes)).map_err(|_| {
                io::Error::new(ErrorKind::InvalidData, "daemon log retention size overflow")
            })?,
        ))?;
        io::copy(&mut source, &mut temporary)?;
        temporary.sync_all()?;

        let mut output = OpenOptions::new().read(true).write(true).open(log_path)?;
        output.set_len(0)?;
        output.seek(SeekFrom::Start(0))?;
        temporary.seek(SeekFrom::Start(0))?;
        io::copy(&mut temporary, &mut output)?;
        output.sync_all()?;

        let append = OpenOptions::new().append(true).open(log_path)?;
        rebind_output_descriptor(append.as_raw_fd(), target_fd)?;
        Ok(true)
    })();
    let _ = fs::remove_file(&temporary_path);
    result
}

fn create_rotation_temporary(parent: &Path) -> io::Result<(PathBuf, File)> {
    for _ in 0..16 {
        let path = parent.join(format!(
            ".xmatrix-daemon-log-rotate-{}",
            uuid::Uuid::new_v4()
        ));
        match OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
        {
            Ok(file) => return Ok((path, file)),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        ErrorKind::AlreadyExists,
        "could not create a unique daemon log rotation temporary file",
    ))
}

// `st_dev` is `u64` on Linux but `i32` on macOS; the cast mirrors how std's
// `MetadataExt::dev()` widens it, so it is only redundant on Linux.
#[allow(clippy::unnecessary_cast)]
fn fd_matches_path(fd: libc::c_int, metadata: &fs::Metadata) -> bool {
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    // fstat only initializes `stat` on success, which is checked before the
    // value is read. It lets us avoid redirecting a foreground daemon whose
    // output is not launchd's configured log file.
    unsafe {
        if libc::fstat(fd, stat.as_mut_ptr()) != 0 {
            return false;
        }
        let stat = stat.assume_init();
        metadata.dev() == stat.st_dev as u64 && metadata.ino() == stat.st_ino as u64
    }
}

fn rebind_output_descriptor(source_fd: libc::c_int, target_fd: libc::c_int) -> io::Result<()> {
    // `source_fd` is an open O_APPEND descriptor for the verified regular log
    // file. dup2 replaces only this daemon's inherited launchd stream.
    if unsafe { libc::dup2(source_fd, target_fd) } == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "xmatrix-daemon-log-rotation-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn rotation_retains_the_tail_and_keeps_the_bound_descriptor_writable() {
        let root = TempRoot::new();
        let log_path = root.0.join("xmatrix-daemon.err.log");
        fs::write(&log_path, b"0123456789abcdef").unwrap();
        let mut bound_log = OpenOptions::new().append(true).open(&log_path).unwrap();

        assert!(rotate_bound_log(&log_path, bound_log.as_raw_fd(), 12, 4).unwrap());
        bound_log.write_all(b"-next").unwrap();
        bound_log.flush().unwrap();
        drop(bound_log);

        assert_eq!(fs::read(&log_path).unwrap(), b"cdef-next");
    }

    #[test]
    fn rotation_skips_a_log_below_its_bound() {
        let root = TempRoot::new();
        let log_path = root.0.join("xmatrix-daemon.log");
        fs::write(&log_path, b"small").unwrap();
        let bound_log = OpenOptions::new().append(true).open(&log_path).unwrap();

        assert!(!rotate_bound_log(&log_path, bound_log.as_raw_fd(), 5, 2).unwrap());
        assert_eq!(fs::read(&log_path).unwrap(), b"small");
    }
}
