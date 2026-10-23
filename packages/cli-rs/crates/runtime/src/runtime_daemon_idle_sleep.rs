//! Idle Instance sleep (docs/instance-sleep.md §2).
//!
//! An Instance is not its process: the Hub decides when a resting Run sleeps,
//! and this daemon ends its process tree exactly like a retained stop and
//! reports the exit as a sleep. The Hub keeps the Instance in its Channel and
//! wakes it, through the ordinary reborn, on the next message.
//!
//! This module holds the checks only: whether this daemon's own facts agree
//! that a Run the Hub named rests, and which wrappers failed at startup and
//! linger. The registry owns the effects.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

/// The status phase the daemon stamps on a Run it put to sleep. The exit
/// report reads it back, so a daemon restart between the stop and the report
/// still reports a sleep.
pub(crate) const SLEEPING_PHASE: &str = "sleeping";

/// A wrapper that already reported a startup failure but never exited only
/// holds memory and a checkout; it is ended once it has sat this long.
const FAILED_STARTUP_GRACE: Duration = Duration::from_secs(60);

/// Phases in which a wrapper waits for its next message. Also any
/// `*_app_ready` phase (codex / grok / acp / …): the provider is up and idle.
const RESTING_PHASES: &[&str] = &[
    "turn_completed",
    "turn_failed",
    "turn_interrupted",
    "relay_registered",
    "channel_joined",
    "model_selected",
    "effort_selected",
];

fn is_resting_phase(phase: &str) -> bool {
    RESTING_PHASES.contains(&phase) || phase.ends_with("_app_ready")
}

/// Only an explicit positive count means a watch / Monitor / CI wait is still
/// running. `None` means the runtime never reported tasks (Codex, Cursor, ACP,
/// Grok, or Claude after its stream closed with none open) — that is idle, not
/// "unknown busy".
fn has_background_work(background_tasks: Option<u32>) -> bool {
    background_tasks.is_some_and(|count| count > 0)
}

/// What the monitor knows about one managed Run on this tick.
#[derive(Debug, Clone)]
pub(crate) struct RunIdleView {
    pub key: String,
    pub pid: u32,
    pub resumable_session: bool,
    pub stop_in_progress: bool,
    /// The sidecar marker, only when it was written by this exact pid.
    pub marker: Option<RunIdleMarker>,
}

#[derive(Debug, Clone)]
pub(crate) struct RunIdleMarker {
    pub phase: String,
    pub completed: bool,
    /// A task execution is accepted or running and has not finished.
    pub execution_in_flight: bool,
    /// Newest task-execution update or finish, in Unix milliseconds.
    pub last_execution_millis: Option<u64>,
    pub wrapper_ready_at_millis: Option<u64>,
    /// When the wrapper that owns `pid` last wrote the marker itself. Only the
    /// wrapper stamps it, so the pid named that wrapper at this moment.
    pub updated_at_millis: u64,
    /// Background tasks the provider reports as running. `None` or `0` means
    /// no reported watch; only a positive count holds the Run awake.
    pub background_tasks: Option<u32>,
}

/// A wrapper that failed at startup and has lingered past the grace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LingeringStartup {
    pub key: String,
    pub pid: u32,
    /// The marker's `updated_at_millis`: the wrapper was alive then.
    pub alive_at_millis: u64,
}

/// Remembers when each Run's phase last changed, so a failed startup is ended
/// only once it has sat in that phase for the whole grace.
#[derive(Debug, Default)]
pub(crate) struct FailedStartupTracker {
    phases: HashMap<String, (u32, String, u64)>,
    /// Runs whose process this daemon already ended, or found gone. Their
    /// registry row outlives the process until the exit report is confirmed,
    /// and a dead pid must never be signalled again: it may belong to anyone.
    ended: HashSet<(String, u32)>,
}

impl FailedStartupTracker {
    pub(crate) fn lingering(
        &mut self,
        now_millis: u64,
        runs: &[RunIdleView],
    ) -> Vec<LingeringStartup> {
        let live: HashSet<&str> = runs.iter().map(|run| run.key.as_str()).collect();
        self.phases.retain(|key, _| live.contains(key.as_str()));
        self.ended.retain(|(key, _)| live.contains(key.as_str()));
        let mut lingering = Vec::new();
        for run in runs {
            if self.ended.contains(&(run.key.clone(), run.pid)) {
                continue;
            }
            let Some(marker) = run.marker.as_ref() else {
                continue;
            };
            let entry = self
                .phases
                .entry(run.key.clone())
                .or_insert_with(|| (run.pid, marker.phase.clone(), now_millis));
            if entry.0 != run.pid || entry.1 != marker.phase {
                *entry = (run.pid, marker.phase.clone(), now_millis);
            }
            if !run.stop_in_progress
                && marker.phase == "wrapper_startup_failed"
                && marker.completed
                && now_millis.saturating_sub(entry.2) >= FAILED_STARTUP_GRACE.as_millis() as u64
            {
                lingering.push(LingeringStartup {
                    key: run.key.clone(),
                    pid: run.pid,
                    alive_at_millis: marker.updated_at_millis,
                });
            }
        }
        lingering
    }

    /// Never act on this Run's `pid` again.
    pub(crate) fn note_ended(&mut self, key: &str, pid: u32) {
        self.ended.insert((key.to_string(), pid));
    }
}

/// Delivery and clock slack allowed when the Hub's idle duration is compared
/// with this daemon's own.
const HUB_SLEEP_SLACK: Duration = Duration::from_secs(60);

/// What the daemon does with the Hub's decision that a Run sleeps.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum HubSleepVerdict {
    Sleep {
        phase: String,
        idle_for: Duration,
    },
    /// `not_idle`, `not_running` or `not_resumable`, as the result reports it.
    Decline(&'static str),
}

/// The daemon's own check before it sleeps a Run on the Hub's word. The Hub
/// decides when; only this daemon sees the process, so the Run must still
/// rest with no task execution or background task, and by this daemon's
/// clock have been quiet about as long as the Hub saw it resting.
pub(crate) fn verify_hub_sleep(
    run: &RunIdleView,
    hub_idle_for: Duration,
    now_millis: u64,
) -> HubSleepVerdict {
    if !run.resumable_session {
        return HubSleepVerdict::Decline("not_resumable");
    }
    let Some(marker) = run.marker.as_ref().filter(|_| !run.stop_in_progress) else {
        return HubSleepVerdict::Decline("not_running");
    };
    if !is_resting_phase(&marker.phase)
        || marker.execution_in_flight
        || has_background_work(marker.background_tasks)
    {
        return HubSleepVerdict::Decline("not_idle");
    }
    let last_activity = marker
        .last_execution_millis
        .into_iter()
        .chain(marker.wrapper_ready_at_millis)
        .max()
        .unwrap_or(0);
    let idle_for = Duration::from_millis(now_millis.saturating_sub(last_activity));
    if idle_for + HUB_SLEEP_SLACK < hub_idle_for {
        return HubSleepVerdict::Decline("not_idle");
    }
    HubSleepVerdict::Sleep {
        phase: marker.phase.clone(),
        idle_for,
    }
}

/// Clock skew allowed between a process start time (whole seconds, derived
/// from boot time) and the wrapper's own marker stamp.
const PROCESS_START_SLACK_MILLIS: u64 = 2_000;

/// Whether `pid` is still the wrapper that stamped its marker at
/// `alive_at_millis`. A process that started after that stamp reuses the
/// number of a wrapper that is gone; signalling it would end someone else's
/// process tree.
pub(crate) fn is_marker_writer(pid: u32, alive_at_millis: u64, processes: &[ProcessView]) -> bool {
    processes
        .iter()
        .find(|process| process.pid == pid)
        .is_some_and(|process| {
            process.start_time.saturating_mul(1_000)
                <= alive_at_millis.saturating_add(PROCESS_START_SLACK_MILLIS)
        })
}

/// The runtime subcommand a wrapper was started with (`xmatrix claude ...`).
#[cfg(test)]
pub(crate) fn wrapper_runtime(args: Option<&[String]>) -> Option<String> {
    let first = args?.first()?.trim();
    let name = std::path::Path::new(first)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or(first);
    (!name.is_empty()).then(|| name.to_ascii_lowercase())
}

/// One process, as the pid-reuse check needs it.
#[derive(Debug, Clone, Copy)]
pub(crate) struct ProcessView {
    pub pid: u32,
    /// Seconds since the Unix epoch.
    pub start_time: u64,
}

/// A snapshot of every process, for `is_marker_writer`.
pub(crate) fn process_snapshot() -> Vec<ProcessView> {
    // One-off scan: do not keep a /proc stat handle open per process.
    sysinfo::set_open_files_limit(0);
    let mut system = sysinfo::System::new();
    system.refresh_processes_specifics(
        sysinfo::ProcessesToUpdate::All,
        true,
        sysinfo::ProcessRefreshKind::nothing(),
    );
    system
        .processes()
        .iter()
        .map(|(pid, process)| ProcessView {
            pid: pid.as_u32(),
            start_time: process.start_time(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const WINDOW: Duration = Duration::from_secs(30 * 60);
    const MINUTE: u64 = 60_000;

    fn run(phase: &str) -> RunIdleView {
        RunIdleView {
            key: "run:run-1".into(),
            pid: 42,
            resumable_session: true,
            stop_in_progress: false,
            marker: Some(RunIdleMarker {
                phase: phase.into(),
                // As the wrappers write it: a finished turn is `completed`.
                completed: phase == "turn_completed",
                execution_in_flight: false,
                last_execution_millis: None,
                wrapper_ready_at_millis: None,
                updated_at_millis: 0,
                background_tasks: Some(0),
            }),
        }
    }

    #[test]
    fn only_a_failed_startup_that_lingered_is_ended() {
        let mut tracker = FailedStartupTracker::default();
        let mut view = run("wrapper_startup_failed");
        view.marker.as_mut().unwrap().completed = true;
        view.resumable_session = false;
        let runs = [view];
        assert!(tracker.lingering(0, &runs).is_empty());
        assert_eq!(
            tracker.lingering(MINUTE, &runs),
            vec![LingeringStartup {
                key: "run:run-1".into(),
                pid: 42,
                alive_at_millis: 0
            }]
        );
        // However long it rests, a working Run is the Hub's to sleep.
        let resting = [run("turn_completed")];
        let mut tracker = FailedStartupTracker::default();
        tracker.lingering(0, &resting);
        assert!(tracker.lingering(24 * 60 * MINUTE, &resting).is_empty());
    }

    #[test]
    fn the_wrapper_runtime_is_its_first_argument() {
        let args = [
            "claude".to_string(),
            "--dangerously-skip-permissions".into(),
        ];
        assert_eq!(wrapper_runtime(Some(&args)).as_deref(), Some("claude"));
        let path = ["/opt/bin/Codex.exe".to_string()];
        assert_eq!(wrapper_runtime(Some(&path)).as_deref(), Some("codex"));
        assert_eq!(wrapper_runtime(None), None);
        assert_eq!(wrapper_runtime(Some(&[])), None);
    }

    fn process(pid: u32, start_time: u64) -> ProcessView {
        ProcessView { pid, start_time }
    }

    #[test]
    fn an_ended_run_is_never_acted_on_again() {
        // A failed wrapper whose exit report never finalizes keeps its row.
        let mut tracker = FailedStartupTracker::default();
        let mut failed = run("wrapper_startup_failed");
        failed.marker.as_mut().unwrap().completed = true;
        let runs = [failed];
        tracker.lingering(0, &runs);
        assert_eq!(tracker.lingering(MINUTE, &runs).len(), 1);
        tracker.note_ended("run:run-1", 42);
        assert!(tracker.lingering(2 * MINUTE, &runs).is_empty());
        assert!(tracker.lingering(60 * MINUTE, &runs).is_empty());
        // Once the row is gone and a new Run reuses the key, it is judged anew.
        tracker.lingering(61 * MINUTE, &[]);
        tracker.lingering(62 * MINUTE, &runs);
        assert_eq!(tracker.lingering(63 * MINUTE, &runs).len(), 1);
    }

    #[test]
    fn a_reused_pid_is_not_the_wrapper() {
        // The wrapper (pid 10, started at second 1_000) stamped its marker at
        // second 2_000.
        let alive_at = 2_000_000;
        assert!(is_marker_writer(10, alive_at, &[process(10, 1_000)]));
        assert!(
            is_marker_writer(10, alive_at, &[process(10, 2_001)]),
            "clock slack"
        );
        // It is gone, or another process now holds its number.
        assert!(!is_marker_writer(10, alive_at, &[]));
        assert!(!is_marker_writer(10, alive_at, &[process(10, 2_100)]));
    }

    #[test]
    fn a_hub_sleep_runs_only_when_this_daemon_also_sees_the_run_quiet() {
        let quiet = |phase: &str, last_execution: u64| {
            let mut view = run(phase);
            view.marker.as_mut().unwrap().last_execution_millis = Some(last_execution);
            view
        };
        // Quiet here as long as the Hub saw it: it sleeps, with the phase it rests in.
        assert_eq!(
            verify_hub_sleep(&quiet("turn_completed", 0), WINDOW, 30 * MINUTE),
            HubSleepVerdict::Sleep {
                phase: "turn_completed".into(),
                idle_for: WINDOW
            }
        );
        // Every harness rests in its own phase, and an unknown or zero
        // background count is no watch (Codex / Cursor / ACP / Grok never
        // report one; Claude writes 0 when its stream closes with none open).
        for phase in [
            "turn_failed",
            "acp_app_ready",
            "grok_app_ready",
            "codex_app_ready",
        ] {
            for background_tasks in [None, Some(0u32)] {
                let mut view = quiet(phase, 0);
                view.marker.as_mut().unwrap().background_tasks = background_tasks;
                assert!(
                    matches!(
                        verify_hub_sleep(&view, WINDOW, 30 * MINUTE),
                        HubSleepVerdict::Sleep { .. }
                    ),
                    "phase={phase} bg={background_tasks:?}"
                );
            }
        }
        // A minute of skew or delivery is tolerated; recent work is not.
        assert!(matches!(
            verify_hub_sleep(&quiet("turn_completed", MINUTE), WINDOW, 30 * MINUTE),
            HubSleepVerdict::Sleep { .. }
        ));
        assert_eq!(
            verify_hub_sleep(&quiet("turn_completed", 20 * MINUTE), WINDOW, 30 * MINUTE),
            HubSleepVerdict::Decline("not_idle")
        );
        // Work in hand, a running turn, or a background watch keep it awake.
        assert_eq!(
            verify_hub_sleep(&quiet("turn_running", 0), WINDOW, 30 * MINUTE),
            HubSleepVerdict::Decline("not_idle")
        );
        let mut watching = quiet("turn_completed", 0);
        watching.marker.as_mut().unwrap().background_tasks = Some(1);
        assert_eq!(
            verify_hub_sleep(&watching, WINDOW, 30 * MINUTE),
            HubSleepVerdict::Decline("not_idle")
        );
        let mut executing = quiet("turn_completed", 0);
        executing.marker.as_mut().unwrap().execution_in_flight = true;
        assert_eq!(
            verify_hub_sleep(&executing, WINDOW, 30 * MINUTE),
            HubSleepVerdict::Decline("not_idle")
        );
        // A Run that cannot resume, or that is already stopping, is not slept.
        let mut fresh = quiet("turn_completed", 0);
        fresh.resumable_session = false;
        assert_eq!(
            verify_hub_sleep(&fresh, WINDOW, 30 * MINUTE),
            HubSleepVerdict::Decline("not_resumable")
        );
        let mut stopping = quiet("turn_completed", 0);
        stopping.stop_in_progress = true;
        assert_eq!(
            verify_hub_sleep(&stopping, WINDOW, 30 * MINUTE),
            HubSleepVerdict::Decline("not_running")
        );
    }
}
