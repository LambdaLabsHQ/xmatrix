//! The daemon's open-file limit.
//!
//! systemd and most shells start a process with a soft `RLIMIT_NOFILE` of
//! 1024, kept low for programs that still use `select()`. The daemon holds a
//! Hub socket, its broker listeners and one connection per in-flight Agent
//! command, Git credential lookup and child pipe. On a host running a dozen
//! Agents and CI at once that reaches 1024: `accept()` then fails with EMFILE
//! and every Agent on the machine loses its `xmatrix` commands and Git
//! credentials until descriptors free up. The hard limit is the ceiling the
//! host grants, so the daemon raises its soft limit towards it at startup.

#![cfg(unix)]

/// Enough for every Run a host can sustain; children inherit it, and some
/// programs walk every descriptor up to their limit when they spawn.
const DAEMON_OPEN_FILES: libc::rlim_t = 65_536;

/// Raise the soft open-file limit to `DAEMON_OPEN_FILES`, or the hard limit if
/// that is lower. Never lowers it. Returns the soft limit now in force.
pub(crate) fn raise_daemon_open_file_limit() -> std::io::Result<libc::rlim_t> {
    let mut limit = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: `limit` is a valid, writable rlimit for the call's duration.
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    let wanted = DAEMON_OPEN_FILES.min(limit.rlim_max);
    if limit.rlim_cur >= wanted {
        return Ok(limit.rlim_cur);
    }
    match set_soft_open_file_limit(wanted, limit.rlim_max) {
        // macOS refuses a soft limit above `kern.maxfilesperproc` even when
        // the hard limit is unlimited; OPEN_MAX is what it always accepts.
        Err(error) if error.raw_os_error() == Some(libc::EINVAL) && wanted > MACOS_OPEN_MAX => {
            let fallback = MACOS_OPEN_MAX.max(limit.rlim_cur);
            set_soft_open_file_limit(fallback, limit.rlim_max).map(|()| fallback)
        }
        result => result.map(|()| wanted),
    }
}

/// `OPEN_MAX` from macOS `<sys/syslimits.h>`.
const MACOS_OPEN_MAX: libc::rlim_t = 10_240;

fn set_soft_open_file_limit(soft: libc::rlim_t, hard: libc::rlim_t) -> std::io::Result<()> {
    let limit = libc::rlimit {
        rlim_cur: soft,
        rlim_max: hard,
    };
    // SAFETY: `limit` is a valid rlimit; a soft limit at or below the hard
    // limit needs no privilege.
    if unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &limit) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn current() -> libc::rlimit {
        let mut limit = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        // SAFETY: `limit` is a valid, writable rlimit for the call's duration.
        assert_eq!(
            unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) },
            0
        );
        limit
    }

    #[test]
    fn the_daemon_opens_past_the_default_1024_files_when_the_host_allows() {
        let before = current();
        let soft = raise_daemon_open_file_limit().expect("raise the open-file limit");
        let after = current();

        assert_eq!(after.rlim_cur, soft);
        assert_eq!(
            after.rlim_max, before.rlim_max,
            "the hard limit is the host's"
        );
        assert!(after.rlim_cur >= before.rlim_cur, "never lowered");
        // Linux grants the full target; macOS may stop at OPEN_MAX.
        assert!(after.rlim_cur >= MACOS_OPEN_MAX.min(before.rlim_max));
        #[cfg(target_os = "linux")]
        assert!(after.rlim_cur >= DAEMON_OPEN_FILES.min(before.rlim_max));
        assert_eq!(
            raise_daemon_open_file_limit().unwrap(),
            soft,
            "raising again is a no-op"
        );
    }
}
