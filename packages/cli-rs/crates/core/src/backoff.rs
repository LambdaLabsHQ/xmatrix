//! The one reconnect backoff every Hub connection loop in the CLI shares.
//!
//! Exponential and capped, with equal jitter: each wait is half the current
//! ceiling plus a random share of the other half. Without jitter every daemon
//! a Hub deploy disconnected redials on the same second and the restarted Hub
//! meets the whole fleet at once; without doubling a Hub that keeps refusing
//! is redialled at the base rate forever.

use std::time::Duration;

/// How long a connection must stay up before it counts as healthy and the
/// backoff starts over. A Hub that accepts the handshake and drops the socket
/// right after must keep the backoff growing, not reset it every time.
pub const HEALTHY_CONNECTION: Duration = Duration::from_secs(30);

#[derive(Debug, Clone)]
pub struct Backoff {
    base: Duration,
    max: Duration,
    ceiling: Duration,
}

impl Backoff {
    pub const fn new(base: Duration, max: Duration) -> Self {
        Self {
            base,
            max,
            ceiling: base,
        }
    }

    /// The next wait, then the ceiling doubles up to `max`.
    pub fn next_delay(&mut self) -> Duration {
        let delay = equal_jitter(self.ceiling);
        self.ceiling = self.ceiling.saturating_mul(2).min(self.max);
        delay
    }

    pub async fn wait(&mut self) {
        tokio::time::sleep(self.next_delay()).await;
    }

    /// The upper bound of the next wait.
    pub fn ceiling(&self) -> Duration {
        self.ceiling
    }

    pub fn reset(&mut self) {
        self.ceiling = self.base;
    }

    /// Starts over only after a connection that stayed up long enough to be
    /// trusted; a session that dropped sooner keeps the grown backoff.
    pub fn reset_if_healthy(&mut self, connected_for: Duration) {
        if connected_for >= HEALTHY_CONNECTION {
            self.reset();
        }
    }
}

/// A wait in `[ceiling / 2, ceiling]`.
pub fn equal_jitter(ceiling: Duration) -> Duration {
    let half = ceiling / 2;
    half + random_share(ceiling - half)
}

/// A wait in `[wait, wait * 1.5]`, never above `cap`: a server-named wait is a
/// floor, and the spread keeps callers it named together from replaying in step.
pub fn jitter_above(wait: Duration, cap: Duration) -> Duration {
    (wait + random_share(wait / 2)).min(cap)
}

/// A uniformly random duration in `[0, span]`.
fn random_share(span: Duration) -> Duration {
    let nanos = span.as_nanos().min(u128::from(u64::MAX)) as u64;
    if nanos == 0 {
        return Duration::ZERO;
    }
    // Jitter only spreads load; a failed entropy read takes the midpoint.
    let sample = getrandom::u64().unwrap_or(u64::MAX / 2);
    Duration::from_nanos(sample % (nanos + 1))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn waits_double_up_to_the_cap_and_stay_within_their_jitter_range() {
        let mut backoff = Backoff::new(Duration::from_secs(1), Duration::from_secs(30));
        let mut ceilings = Vec::new();
        for _ in 0..8 {
            let ceiling = backoff.ceiling();
            let delay = backoff.next_delay();
            assert!(
                delay >= ceiling / 2 && delay <= ceiling,
                "{delay:?} outside {ceiling:?}"
            );
            ceilings.push(ceiling.as_secs());
        }
        assert_eq!(ceilings, [1, 2, 4, 8, 16, 30, 30, 30]);
    }

    #[test]
    fn jitter_spreads_waits_rather_than_repeating_one() {
        let samples: std::collections::HashSet<_> = (0..64)
            .map(|_| equal_jitter(Duration::from_secs(10)))
            .collect();
        assert!(samples.len() > 1, "64 jittered waits were all equal");
        assert!(
            samples
                .iter()
                .all(|delay| *delay >= Duration::from_secs(5) && *delay <= Duration::from_secs(10))
        );
        assert_eq!(equal_jitter(Duration::ZERO), Duration::ZERO);
    }

    #[test]
    fn only_a_connection_that_stayed_up_resets_the_backoff() {
        let mut backoff = Backoff::new(Duration::from_secs(1), Duration::from_secs(30));
        backoff.next_delay();
        backoff.next_delay();
        backoff.reset_if_healthy(Duration::from_secs(2));
        assert_eq!(backoff.ceiling(), Duration::from_secs(4));
        backoff.reset_if_healthy(HEALTHY_CONNECTION);
        assert_eq!(backoff.ceiling(), Duration::from_secs(1));
    }

    #[test]
    fn a_server_named_wait_is_a_floor_and_the_cap_still_holds() {
        for _ in 0..32 {
            let wait = jitter_above(Duration::from_secs(4), Duration::from_secs(30));
            assert!(wait >= Duration::from_secs(4) && wait <= Duration::from_secs(6));
        }
        assert_eq!(
            jitter_above(Duration::from_secs(30), Duration::from_secs(30)),
            Duration::from_secs(30)
        );
    }
}
