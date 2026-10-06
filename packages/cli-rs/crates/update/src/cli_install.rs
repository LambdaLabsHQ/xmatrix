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

#[cfg(windows)]
fn publish(temporary: &Path, destination: &Path) -> error::Result<()> {
    std::fs::copy(temporary, destination)?;
    let _ = std::fs::remove_file(temporary);
    Ok(())
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

    #[cfg(unix)]
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

    #[test]
    fn a_missing_seed_is_refused() {
        let error = install_cli_from_seed(Some(Path::new("/definitely/missing/seed")), None)
            .unwrap_err()
            .to_string();
        assert!(error.contains("is not a file"), "{error}");
    }
}
