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

const BUSY: &str = "Private journal is busy";

pub(super) fn lock(path: &Path) -> Result<JournalLock, String> {
    // Refuses a symlink or directory planted under the lock's name before it
    // is opened; a lock file released meanwhile is simply created again.
    if let Err(error) = private(path, false)
        && path.exists()
    {
        return Err(error);
    }
    let mut options = OpenOptions::new();
    options.create(true).truncate(false).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path).map_err(|error| {
        // Windows keeps a released lock file's name until its last handle
        // closes; opening it meanwhile is refused, and the name is free again
        // a moment later.
        if cfg!(windows) && error.kind() == std::io::ErrorKind::PermissionDenied {
            BUSY
        } else {
            "Private journal lock is unavailable"
        }
    })?;
    file.try_lock_exclusive().map_err(|_| BUSY)?;
    // A lock on a file its holder released (`release_lock`) guards nothing:
    // the next caller creates a new file under the same name and both would
    // hold "the" lock. Whoever lost that race asks again.
    if !names(path, &file) {
        return Err(BUSY.into());
    }
    private(path, false)?;
    Ok(JournalLock(file))
}

/// Whether `path` still names the open `file`.
#[cfg(unix)]
fn names(path: &Path, file: &File) -> bool {
    use std::os::unix::fs::MetadataExt as _;
    let identity = |metadata: fs::Metadata| (metadata.dev(), metadata.ino());
    match (fs::symlink_metadata(path), file.metadata()) {
        (Ok(named), Ok(held)) => identity(named) == identity(held),
        _ => false,
    }
}

/// Windows refuses to open a name whose file is being deleted, so a lock
/// taken there is always on the file the name still means.
#[cfg(not(unix))]
fn names(path: &Path, _file: &File) -> bool {
    path.exists()
}

/// Remove a lock file while holding it, so a lock that guards nothing does
/// not stay behind. `still_unused` is asked under the lock.
pub(super) fn release_lock(path: &Path, still_unused: impl FnOnce() -> bool) -> bool {
    let Ok(_guard) = lock(path) else {
        return false;
    };
    still_unused() && fs::remove_file(path).is_ok()
}

pub(super) fn lock_with_deadline(path: &Path) -> Result<JournalLock, String> {
    let started = std::time::Instant::now();
    loop {
        match lock(path) {
            Err(error)
                if error == BUSY && started.elapsed() < std::time::Duration::from_millis(250) =>
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

#[cfg(test)]
mod tests {
    use super::*;

    fn lock_path() -> (PathBuf, PathBuf) {
        let root =
            std::env::temp_dir().join(format!("xmatrix-private-journal-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        (root.clone(), root.join("record.lock"))
    }

    #[test]
    fn a_released_lock_is_removed_only_while_nobody_holds_or_needs_it() {
        let (root, path) = lock_path();
        let held = lock(&path).unwrap();
        assert!(!release_lock(&path, || true), "a held lock stays");
        drop(held);
        assert!(!release_lock(&path, || false), "a lock still in use stays");
        assert!(path.exists());
        assert!(release_lock(&path, || true));
        assert!(!path.exists());
        drop(lock(&path).expect("the name is free for the next holder"));
        fs::remove_dir_all(root).unwrap();
    }

    /// The race `names` closes: a holder that opened the file just before it
    /// was released must not believe it holds the lock the name now means.
    #[cfg(unix)]
    #[test]
    fn a_lock_on_a_released_file_is_not_the_lock() {
        let (root, path) = lock_path();
        let stale = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        assert!(release_lock(&path, || true));
        stale.try_lock_exclusive().unwrap();
        assert!(!names(&path, &stale), "the released file has no name");
        let current = lock(&path).unwrap();
        assert!(!names(&path, &stale), "the name means the new file");
        assert!(names(&path, &current.0));
        fs::remove_dir_all(root).unwrap();
    }
}
