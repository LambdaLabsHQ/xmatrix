//! The one place an instant becomes text an agent will read.
//!
//! Everything xMatrix stores or sends is UTC RFC-3339 with a trailing `Z`, and
//! an instance is told so. That is not enough on its own: a model asked how
//! long a channel has been quiet has to subtract, and the only other clock it
//! has is the provider's local one. Subtracting a UTC timestamp from a local
//! wall clock is wrong by exactly the machine's UTC offset — a Focus review on
//! a UTC+8 machine read a reply sent four minutes earlier as eight hours of
//! silence, and told the channel so.
//!
//! Two defences, in order of preference:
//!
//! 1. [`relative_age`] — answer "how long ago" with a duration. A duration has
//!    no zone, so a reader that only repeats it cannot be wrong. Prefer this
//!    wherever the question is recency rather than a particular instant.
//! 2. [`now_utc_rfc3339`] — when an absolute instant is genuinely what is
//!    wanted, give the reader "now" in the same zone the instant is in, so the
//!    subtraction it falls back to has both operands in one zone.

const MINUTE_SECONDS: i64 = 60;
const HOUR_SECONDS: i64 = 60 * MINUTE_SECONDS;
const DAY_SECONDS: i64 = 24 * HOUR_SECONDS;

const RFC3339: &time::format_description::well_known::Rfc3339 =
    &time::format_description::well_known::Rfc3339;

/// The wall clock as RFC-3339 in UTC, the zone every xMatrix timestamp is in.
///
/// `None` only if the clock cannot be formatted at all, which callers report as
/// "no anchor" rather than substituting a plausible-looking wrong one.
pub fn now_utc_rfc3339() -> Option<String> {
    time::OffsetDateTime::now_utc().format(RFC3339).ok()
}

/// How long before `now` the instant `sent_at` was, as a duration.
///
/// Both arguments are RFC-3339; either being unparseable yields `None`, so a
/// caller omits the age rather than printing a guess. An instant slightly in
/// the future — a sender's clock running ahead — reads as `just now` instead
/// of a negative age.
pub fn relative_age(sent_at: &str, now: &str) -> Option<String> {
    let sent = time::OffsetDateTime::parse(sent_at, RFC3339).ok()?;
    let now = time::OffsetDateTime::parse(now, RFC3339).ok()?;
    Some(describe_age((now - sent).whole_seconds()))
}

/// Floored, never rounded up: a stated age has always already elapsed.
fn describe_age(seconds: i64) -> String {
    let seconds = seconds.max(0);
    if seconds < MINUTE_SECONDS {
        return "just now".to_string();
    }
    if seconds < HOUR_SECONDS {
        return format!("{}m ago", seconds / MINUTE_SECONDS);
    }
    if seconds < DAY_SECONDS {
        return format!("{}h ago", seconds / HOUR_SECONDS);
    }
    format!("{}d ago", seconds / DAY_SECONDS)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The instants that produced the defect, kept as the regression it is:
    /// 20:24:45Z answered at 20:28:34Z is four minutes, and was reported as
    /// eight hours because the reader subtracted a UTC+8 wall clock.
    #[test]
    fn the_eight_hour_report_was_four_minutes() {
        assert_eq!(
            relative_age("2026-09-18T20:24:45Z", "2026-09-18T20:28:34Z").as_deref(),
            Some("3m ago")
        );
    }

    #[test]
    fn ages_climb_through_minutes_hours_and_days() {
        let now = "2026-09-18T20:28:34Z";
        assert_eq!(
            relative_age("2026-09-18T20:28:00Z", now).as_deref(),
            Some("just now")
        );
        assert_eq!(
            relative_age("2026-09-18T19:29:00Z", now).as_deref(),
            Some("59m ago")
        );
        assert_eq!(
            relative_age("2026-09-18T12:28:34Z", now).as_deref(),
            Some("8h ago")
        );
        assert_eq!(
            relative_age("2026-09-16T20:28:34Z", now).as_deref(),
            Some("2d ago")
        );
    }

    #[test]
    fn a_sender_clock_running_ahead_reads_as_just_now() {
        assert_eq!(
            relative_age("2026-09-18T20:30:00Z", "2026-09-18T20:28:34Z").as_deref(),
            Some("just now")
        );
    }

    #[test]
    fn an_unparseable_instant_has_no_age_instead_of_a_guess() {
        assert_eq!(relative_age("yesterday", "2026-09-18T20:28:34Z"), None);
        assert_eq!(relative_age("2026-09-18T20:28:34Z", "now"), None);
    }

    #[test]
    fn the_clock_reads_in_utc() {
        let now = now_utc_rfc3339().expect("a formattable clock");
        assert!(now.ends_with('Z'), "{now} must be UTC, not a local offset");
        assert!(time::OffsetDateTime::parse(&now, RFC3339).is_ok());
    }
}
