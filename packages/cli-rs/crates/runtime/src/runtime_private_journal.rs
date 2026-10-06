//! Owner-only, locked, atomic local journal files. No product authority lives here.
#[cfg(windows)]
use crate::windows_acl;
use fs2::FileExt as _;
use std::fs::{self, File, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use xmatrix_cli_core::config;

pub(super) struct JournalLock(pub(super) File);

impl Drop for JournalLock {
    fn drop(&mut self) {
        // Closing one descriptor does not release flock while a concurrent
        // fork still holds the same open file description before exec.
        let _ = fs2::FileExt::unlock(&self.0);
    }
}

pub(super) fn private(path: &Path, directory: bool) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "Private journal is unavailable")?;
    if metadata.file_type().is_symlink()
        || if directory {
            !metadata.is_dir()
        } else {
            !metadata.is_file()
        }
    {
        return Err("Private journal path is not a regular private artifact".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(
            path,
            fs::Permissions::from_mode(if directory { 0o700 } else { 0o600 }),
        )
        .map_err(|_| "Private journal permissions could not be secured")?;
    }
    #[cfg(windows)]
    windows_acl::apply_and_verify_owner_only(path, directory)
        .map_err(|_| "Private journal permissions could not be secured")?;
    Ok(())
}

pub(super) fn lock(path: &Path) -> Result<JournalLock, String> {
    if path.exists() {
        private(path, false)?;
    }
    let mut options = OpenOptions::new();
    options.create(true).truncate(false).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let file = options
        .open(path)
        .map_err(|_| "Private journal lock is unavailable")?;
    private(path, false)?;
    file.try_lock_exclusive()
        .map_err(|_| "Private journal is busy")?;
    Ok(JournalLock(file))
}

pub(super) fn lock_with_deadline(path: &Path) -> Result<JournalLock, String> {
    let started = std::time::Instant::now();
    loop {
        match lock(path) {
            Err(error)
                if error == "Private journal is busy"
                    && started.elapsed() < std::time::Duration::from_millis(250) =>
            {
                std::thread::sleep(std::time::Duration::from_millis(2));
            }
            outcome => return outcome,
        }
    }
}

/// A record written and flushed to disk but not yet visible at its target.
///
/// Staging is separated from installation so the expensive half — creating the
/// temporary file and `fsync`ing its contents — happens before the caller takes
/// the lock that guards the target. A record's bytes never depend on what is
/// already stored, only on what the caller was asked to write, so nothing about
/// this ordering can observe stale state.
pub(super) struct StagedRecord {
    temporary: PathBuf,
    target: PathBuf,
    installed: bool,
}

impl Drop for StagedRecord {
    fn drop(&mut self) {
        // An abandoned stage must never be left behind for the directory scan
        // to trip over, whether it was rejected or an error unwound past it.
        if !self.installed {
            let _ = fs::remove_file(&self.temporary);
        }
    }
}

impl StagedRecord {
    /// Publish the staged bytes. The caller must already hold the lock guarding
    /// this target.
    pub(super) fn install(mut self) -> Result<(), String> {
        #[cfg(windows)]
        let replacement = windows_acl::atomic_replace(&self.temporary, &self.target);
        #[cfg(not(windows))]
        let replacement = config::replace_file_atomically(&self.temporary, &self.target);
        replacement.map_err(|_| "Private journal record could not be installed")?;
        self.installed = true;
        #[cfg(unix)]
        File::open(
            self.target
                .parent()
                .ok_or("Private journal parent is missing")?,
        )
        .and_then(|dir| dir.sync_all())
        .map_err(|_| "Private journal record directory could not be persisted")?;
        Ok(())
    }
}

/// Write and flush `bytes` next to `path` without publishing them there.
pub(super) fn stage_bytes(path: &Path, bytes: &[u8]) -> Result<StagedRecord, String> {
    let temporary = config::unique_temporary_path(path);
    let outcome = (|| {
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|_| "Private journal record could not be created")?;
        private(&temporary, false)?;
        file.write_all(bytes)
            .and_then(|()| file.sync_all())
            .map_err(|_| "Private journal record could not be persisted")?;
        Ok(())
    })();
    match outcome {
        Ok(()) => Ok(StagedRecord {
            temporary,
            target: path.to_path_buf(),
            installed: false,
        }),
        Err(error) => {
            let _ = fs::remove_file(&temporary);
            Err(error)
        }
    }
}

pub(super) fn write_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    stage_bytes(path, bytes)?.install()
}
