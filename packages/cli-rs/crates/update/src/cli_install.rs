//! Installing the CLI from a seed copy — the Desktop App's bundled binary.
//!
//! The steps are the ones `install.sh` performs for a downloaded binary:
//! copy into the user's bin directory, prove the copy runs, replace
//! atomically. Living in the binary lets the App and the script share them.

use std::path::{Path, PathBuf};
use std::process::Command;

use xmatrix_cli_core::error::{self, CliError};

pub const CLI_BINARY_NAME: &str = if cfg!(windows) {
    "xmatrix.exe"
} else {
    "xmatrix"
};

/// User-owned default, matching the installers: never a system directory.
pub fn default_install_dir() -> error::Result<PathBuf> {
    dirs::home_dir()
        .map(|home| home.join(".local").join("bin"))
        .ok_or_else(|| CliError::Launch("HOME is unavailable for the CLI install directory".into()))
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InstalledCliSeed {
    pub path: PathBuf,
    pub install_dir: PathBuf,
    /// First line of the installed copy's `--version`, proving it runs.
    pub version: String,
}

/// Copies `from` (default: this executable) into `into` (default:
/// `~/.local/bin`) as `xmatrix`, validates the copy, and publishes it in
/// place of any previous install. A failed validation leaves the previous
/// install untouched.
pub fn install_cli_from_seed(
    from: Option<&Path>,
    into: Option<&Path>,
) -> error::Result<InstalledCliSeed> {
    let seed = match from {
        Some(path) => absolute(path)?,
        None => std::env::current_exe()?,
    };
    if !seed.is_file() {
        return Err(CliError::Launch(format!(
            "seed binary {} is not a file",
            seed.display()
        )));
    }
    let install_dir = match into {
        Some(path) => absolute(path)?,
        None => default_install_dir()?,
    };
    std::fs::create_dir_all(&install_dir)?;
    let destination = install_dir.join(CLI_BINARY_NAME);
    let temporary = xmatrix_cli_core::config::unique_temporary_path(&destination);
    std::fs::copy(&seed, &temporary)?;
    let placed = super::make_executable(&temporary)
        .and_then(|()| reported_version(&temporary))
        .and_then(|version| publish(&temporary, &destination).map(|()| version));
    match placed {
        Ok(version) => Ok(InstalledCliSeed {
            path: destination,
            install_dir,
            version,
        }),
        Err(error) => {
            let _ = std::fs::remove_file(&temporary);
            Err(error)
        }
    }
}

fn absolute(path: &Path) -> error::Result<PathBuf> {
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        Ok(std::env::current_dir()?.join(path))
    }
}

fn reported_version(binary: &Path) -> error::Result<String> {
    let mut command = Command::new(binary);
    super::configure_background_command(&mut command);
    command.arg("--version");
    let output = retry_busy_seed_start(|| command.output())
        .map_err(|error| CliError::Launch(format!("seed binary failed to start: {error}")))?;
    let version = String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .unwrap_or_default()
        .trim()
        .to_string();
    if !output.status.success() || version.is_empty() {
        return Err(CliError::Launch(
            "seed binary did not report a version; refusing to install it".into(),
        ));
    }
    Ok(version)
}

// A freshly copied executable can briefly return ETXTBSY on Unix. Retry only
// that pre-start error; never retry a started process or relax version checks.
// Persistent failures still leave the previous install untouched.
fn retry_busy_seed_start<T>(mut start: impl FnMut() -> std::io::Result<T>) -> std::io::Result<T> {
    for attempt in 0..4 {
        match start() {
            Err(error) if cfg!(unix) && error.raw_os_error() == Some(26) && attempt < 3 => {
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            result => return result,
        }
    }
    unreachable!("last attempt always returns")
}

/// Windows cannot overwrite or delete an executable that is running (the
/// login daemon runs the installed `xmatrix.exe` itself), but it can rename
/// one. When the destination cannot be replaced in place, it is moved aside
/// to a unique name in the same directory, the new copy takes its place, and
/// the aside copy is deleted once nothing runs it — on this install if
/// possible, otherwise on a later one.
#[cfg(windows)]
fn publish(temporary: &Path, destination: &Path) -> error::Result<()> {
    remove_stale_aside_copies(destination);
    let in_place = match std::fs::rename(temporary, destination) {
        Ok(()) => return Ok(()),
        Err(error) if !destination.exists() => return Err(error.into()),
        Err(error) => error,
    };
    let aside = aside_path(destination);
    std::fs::rename(destination, &aside).map_err(|error| {
        CliError::Launch(format!(
            "could not replace {} ({in_place}) or move it aside: {error}",
            destination.display()
        ))
    })?;
    if let Err(error) = std::fs::rename(temporary, destination) {
        let _ = std::fs::rename(&aside, destination);
        return Err(error.into());
    }
    let _ = std::fs::remove_file(&aside);
    Ok(())
}

#[cfg_attr(not(windows), allow(dead_code))]
const ASIDE_MARKER: &str = ".old-";

/// A unique same-directory name for a replaced binary that may still run.
#[cfg_attr(not(windows), allow(dead_code))]
fn aside_path(destination: &Path) -> PathBuf {
    let mut name = destination.file_name().unwrap_or_default().to_os_string();
    name.push(format!(
        "{ASIDE_MARKER}{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0)
    ));
    destination.with_file_name(name)
}

/// Best effort: deletes copies an earlier install moved aside. One still
/// running stays until a later install; only exact aside names of this
/// destination are touched.
#[cfg_attr(not(windows), allow(dead_code))]
fn remove_stale_aside_copies(destination: &Path) {
    let (Some(directory), Some(binary)) = (
        destination.parent(),
        destination.file_name().and_then(|name| name.to_str()),
    ) else {
        return;
    };
    let prefix = format!("{binary}{ASIDE_MARKER}");
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let is_aside = entry
            .file_name()
            .to_str()
            .is_some_and(|name| name.starts_with(&prefix));
        if is_aside && entry.file_type().is_ok_and(|kind| kind.is_file()) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[cfg(not(windows))]
fn publish(temporary: &Path, destination: &Path) -> error::Result<()> {
    super::replace_downloaded_binary(temporary, destination)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn assert_install_cleanup(root: &Path, install_dir: &Path) {
        let leftovers: Vec<_> = std::fs::read_dir(install_dir).unwrap().flatten().collect();
        assert_eq!(leftovers.len(), 1, "temporary copies must not remain");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn busy_seed_start_retries_only_until_the_executable_can_start() {
        let mut calls = 0;
        let result = retry_busy_seed_start(|| {
            calls += 1;
            if calls < 3 {
                Err(std::io::Error::from_raw_os_error(26))
            } else {
                Ok("started")
            }
        });
        assert_eq!(result.unwrap(), "started");
        assert_eq!(calls, 3);
    }

    #[cfg(unix)]
    #[test]
    fn persistent_busy_seed_start_has_a_fixed_attempt_bound() {
        let mut calls = 0;
        let result = retry_busy_seed_start::<()>(|| {
            calls += 1;
            Err(std::io::Error::from_raw_os_error(26))
        });
        assert_eq!(result.unwrap_err().raw_os_error(), Some(26));
        assert_eq!(calls, 4);
    }

    #[test]
    fn other_seed_start_errors_fail_without_retry() {
        let mut calls = 0;
        let result = retry_busy_seed_start::<()>(|| {
            calls += 1;
            Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied))
        });
        assert_eq!(
            result.unwrap_err().kind(),
            std::io::ErrorKind::PermissionDenied
        );
        assert_eq!(calls, 1);
    }

    #[test]
    fn the_default_install_directory_is_the_user_owned_local_bin() {
        let dir = default_install_dir().unwrap();
        assert!(
            dir.ends_with(Path::new(".local").join("bin")),
            "{}",
            dir.display()
        );
    }

    fn temp_root(label: &str) -> PathBuf {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("xmatrix-cli-install-{label}-{nonce}"));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[cfg(unix)]
    fn seed(root: &Path, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let seed = root.join("seed");
        std::fs::write(&seed, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&seed, std::fs::Permissions::from_mode(0o755)).unwrap();
        seed
    }

    #[cfg(unix)]
    #[test]
    fn a_runnable_seed_is_installed_executable_and_reports_its_version() {
        use std::os::unix::fs::PermissionsExt;
        let root = temp_root("ok");
        let seed = seed(&root, "echo 'xmatrix 9.9.9-seed'");
        let into = root.join("bin");

        let installed = install_cli_from_seed(Some(&seed), Some(&into)).unwrap();
        assert_eq!(installed.path, into.join("xmatrix"));
        assert_eq!(installed.install_dir, into);
        assert_eq!(installed.version, "xmatrix 9.9.9-seed");
        assert!(
            std::fs::metadata(&installed.path)
                .unwrap()
                .permissions()
                .mode()
                & 0o111
                != 0
        );
        assert_install_cleanup(&root, &into);
    }

    #[cfg(unix)]
    #[test]
    fn a_seed_that_cannot_report_a_version_never_replaces_the_install() {
        let root = temp_root("broken");
        let into = root.join("bin");
        std::fs::create_dir_all(&into).unwrap();
        std::fs::write(into.join("xmatrix"), b"previous install").unwrap();
        let seed = seed(&root, "exit 1");

        let error = install_cli_from_seed(Some(&seed), Some(&into))
            .unwrap_err()
            .to_string();
        assert!(error.contains("did not report a version"), "{error}");
        assert_eq!(
            std::fs::read(into.join("xmatrix")).unwrap(),
            b"previous install"
        );
        assert_install_cleanup(&root, &into);
    }

    fn directory_names(directory: &Path) -> Vec<String> {
        let mut names: Vec<_> = std::fs::read_dir(directory)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn stale_aside_cleanup_removes_only_this_binarys_aside_copies() {
        let root = temp_root("aside");
        let destination = root.join("xmatrix.exe");
        std::fs::write(&destination, b"current").unwrap();
        std::fs::write(aside_path(&destination), b"replaced").unwrap();
        std::fs::write(root.join("xmatrix.exe.tmp-1-2"), b"in flight").unwrap();
        std::fs::write(root.join("other.exe.old-1-2"), b"not ours").unwrap();
        std::fs::create_dir(root.join("xmatrix.exe.old-dir")).unwrap();

        remove_stale_aside_copies(&destination);

        assert_eq!(
            directory_names(&root),
            [
                "other.exe.old-1-2",
                "xmatrix.exe",
                "xmatrix.exe.old-dir",
                "xmatrix.exe.tmp-1-2"
            ]
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "subprocess helper for the running-install replacement regression"]
    fn running_install_helper() {
        if std::env::var("XMATRIX_TEST_RUNNING_INSTALL_HELPER").as_deref() == Ok("1") {
            std::thread::sleep(std::time::Duration::from_secs(60));
        }
    }

    // The login daemon runs the installed xmatrix.exe, so the Desktop seed
    // install must replace an executable that is running (os error 32/33).
    #[cfg(windows)]
    #[test]
    fn installing_over_a_running_executable_replaces_it() {
        let root = temp_root("running");
        let destination = root.join(CLI_BINARY_NAME);
        std::fs::copy(std::env::current_exe().unwrap(), &destination).unwrap();
        let mut running = Command::new(&destination)
            .args([
                "--exact",
                "cli_install::tests::running_install_helper",
                "--ignored",
            ])
            .env("XMATRIX_TEST_RUNNING_INSTALL_HELPER", "1")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let temporary = xmatrix_cli_core::config::unique_temporary_path(&destination);
        std::fs::write(&temporary, b"new install").unwrap();

        let published = publish(&temporary, &destination);
        let names = directory_names(&root);
        let _ = running.kill();
        let _ = running.wait();
        published.unwrap();
        assert_eq!(std::fs::read(&destination).unwrap(), b"new install");
        assert_eq!(names.len(), 2, "the running copy waits aside: {names:?}");

        remove_stale_aside_copies(&destination);
        assert_eq!(directory_names(&root), [CLI_BINARY_NAME]);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_missing_seed_is_refused() {
        let error = install_cli_from_seed(Some(Path::new("/definitely/missing/seed")), None)
            .unwrap_err()
            .to_string();
        assert!(error.contains("is not a file"), "{error}");
    }
}
