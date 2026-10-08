//! An About file must be one this Run wrote. A session that applies its About
//! before its own write succeeded would otherwise save whatever an earlier
//! session left at the same path, which is another Channel's summary and name.

use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use xmatrix_cli_core::error::{self, CliError};

/// Set by the daemon on every Run it spawns, in Unix milliseconds.
const RUN_SPAWNED_AT_ENV: &str = "XMATRIX_RUN_SPAWNED_AT_MILLIS";

/// Refuse an About file last written before this Run was spawned. Outside a
/// daemon-spawned Run there is no start to compare with, and nothing to refuse.
pub(crate) fn ensure_written_by_this_run(path: &Path, file_flag: &str) -> error::Result<()> {
    let Some(spawned_at) = std::env::var(RUN_SPAWNED_AT_ENV)
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
    else {
        return Ok(());
    };
    let modified = std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .map_err(|error| CliError::Launch(format!("read {}: {error}", path.display())))?;
    if written_before(modified, spawned_at) {
        return Err(CliError::Launch(format!(
            "{file_flag} {} was last written before this Run started, so it is not this Run's text; nothing was saved. Write the file again and apply it once that write has succeeded.",
            path.display()
        )));
    }
    Ok(())
}

fn written_before(modified: SystemTime, spawned_at_millis: u64) -> bool {
    modified < UNIX_EPOCH + Duration::from_millis(spawned_at_millis)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_from_before_the_run_is_not_its_text() {
        let spawned_at = 1_791_446_185_000;
        let at = |millis| UNIX_EPOCH + Duration::from_millis(millis);
        assert!(written_before(at(spawned_at - 1), spawned_at));
        assert!(!written_before(at(spawned_at), spawned_at));
        assert!(!written_before(at(spawned_at + 60_000), spawned_at));
    }
}
