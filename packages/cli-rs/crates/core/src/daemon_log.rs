//! Daemon diagnostics carry the time they were written.
//!
//! A daemon runs for days and its diagnostics go to a file. Without a time on
//! each line an outage cannot be placed against a Hub release, a command or
//! another machine's log, and lines from several daemon lifetimes read as one.
use std::io::Write as _;
use std::sync::atomic::{AtomicBool, Ordering};

static STAMPED: AtomicBool = AtomicBool::new(false);

/// From here on, every diagnostic line this process prints starts with its
/// UTC time. Called once by the long-running daemon; commands a person runs at
/// a terminal keep their plain output.
pub fn stamp_diagnostics() {
    STAMPED.store(true, Ordering::Release);
}

/// `eprintln!` for crates that route their diagnostics here.
pub fn eprintln(args: std::fmt::Arguments<'_>) {
    if !STAMPED.load(Ordering::Acquire) {
        std::eprintln!("{args}");
        return;
    }
    let stamped = stamped_lines(
        &utc_timestamp(time::OffsetDateTime::now_utc()),
        &args.to_string(),
    );
    // A daemon whose log went away keeps running; it has nowhere to report it.
    let _ = std::io::stderr().lock().write_all(stamped.as_bytes());
}

fn stamped_lines(timestamp: &str, text: &str) -> String {
    let mut stamped = String::with_capacity(text.len() + timestamp.len() + 2);
    for line in text.split('\n') {
        stamped.push_str(timestamp);
        stamped.push(' ');
        stamped.push_str(line);
        stamped.push('\n');
    }
    stamped
}

/// RFC 3339 in UTC with milliseconds, the form every xMatrix timestamp takes.
fn utc_timestamp(now: time::OffsetDateTime) -> String {
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second(),
        now.millisecond()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_line_of_a_diagnostic_starts_with_its_utc_time() {
        let at =
            time::OffsetDateTime::from_unix_timestamp_nanos(1_791_895_200_123_000_000).unwrap();
        let timestamp = utc_timestamp(at);
        assert_eq!(timestamp, "2026-10-13T12:40:00.123Z");
        assert_eq!(
            stamped_lines(
                &timestamp,
                "daemon disconnected: reset\n  Restart daemon: xmatrix daemon"
            ),
            "2026-10-13T12:40:00.123Z daemon disconnected: reset\n\
             2026-10-13T12:40:00.123Z   Restart daemon: xmatrix daemon\n"
        );
    }
}
